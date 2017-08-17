"use strict";


/* global  __SCRIPT_URI_SPEC__  */
/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "(startup|shutdown|install|uninstall)" }]*/

const {utils: Cu, interfaces: Ci} = Components;
/* Onobarding */
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "OnboardingTourType",
  "resource://onboarding/modules/OnboardingTourType.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Services",
  "resource://gre/modules/Services.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "fxAccounts",
  "resource://gre/modules/FxAccounts.jsm");

/* Shield */
const CONFIGPATH = `${__SCRIPT_URI_SPEC__}/../Config.jsm`;
const { config } = Cu.import(CONFIGPATH, {});
const studyConfig = config.study;
Cu.import("resource://gre/modules/Console.jsm");
const log = createLog(studyConfig.studyName, config.log.bootstrap.level);  // defined below.

const STUDYUTILSPATH = `${__SCRIPT_URI_SPEC__}/../${studyConfig.studyUtilsPath}`;
const { studyUtils } = Cu.import(STUDYUTILSPATH, {});

/* Onboarding functions and constants */
const {PREF_STRING, PREF_BOOL, PREF_INT} = Ci.nsIPrefBranch;

const BROWSER_READY_NOTIFICATION = "browser-delayed-startup-finished";
const BROWSER_SESSION_STORE_NOTIFICATION = "sessionstore-windows-restored";
const PREF_WHITELIST = [
  ["browser.onboarding.enabled", PREF_BOOL],
  ["browser.onboarding.hidden", PREF_BOOL],
  ["browser.onboarding.notification.finished", PREF_BOOL],
  ["browser.onboarding.notification.prompt-count", PREF_INT],
  ["browser.onboarding.notification.last-time-of-changing-tour-sec", PREF_INT],
  ["browser.onboarding.notification.tour-ids-queue", PREF_STRING],
];

[
  "onboarding-tour-addons",
  "onboarding-tour-customize",
  "onboarding-tour-default-browser",
  "onboarding-tour-library",
  "onboarding-tour-performance",
  "onboarding-tour-private-browsing",
  "onboarding-tour-search",
  "onboarding-tour-singlesearch",
  "onboarding-tour-sync",
].forEach(tourId => PREF_WHITELIST.push([`browser.onboarding.tour.${tourId}.completed`, PREF_BOOL]));

let waitingForBrowserReady = true;

/**
 * Set pref. Why no `getPrefs` function is due to the priviledge level.
 * We cannot set prefs inside a framescript but can read.
 * For simplicity and effeciency, we still read prefs inside the framescript.
 *
 * @param {Array} prefs the array of prefs to set.
 *   The array element carrys info to set pref, should contain
 *   - {String} name the pref name, such as `browser.onboarding.hidden`
 *   - {*} value the value to set
 **/
function setPrefs(prefs) {
  prefs.forEach(pref => {
    let prefObj = PREF_WHITELIST.find(([name, ]) => name == pref.name);
    if (!prefObj) {
      return;
    }

    let [name, type] = prefObj;

    switch (type) {
      case PREF_BOOL:
        Services.prefs.setBoolPref(name, pref.value);
        break;

      case PREF_INT:
        Services.prefs.setIntPref(name, pref.value);
        break;

      case PREF_STRING:
        Services.prefs.setStringPref(name, pref.value);
        break;

      default:
        throw new TypeError(`Unexpected type (${type}) for preference ${name}.`)
    }
  });
}

/**
 * syncTourChecker listens to and maintains the login status inside, and can be
 * queried at any time once initialized.
 */
let syncTourChecker = {
  _registered: false,
  _loggedIn: false,

  isLoggedIn() {
    return this._loggedIn;
  },

  observe(subject, topic) {
    switch (topic) {
      case "fxaccounts:onlogin":
        this.setComplete();
        break;
      case "fxaccounts:onlogout":
        this._loggedIn = false;
        break;
    }
  },

  init() {
    // Check if we've already logged in at startup.
    fxAccounts.getSignedInUser().then(user => {
      if (user) {
        this.setComplete();
      }
      // Observe for login action if we haven't logged in yet.
      this.register();
    });
  },

  register() {
    if (this._registered) {
      return;
    }
    Services.obs.addObserver(this, "fxaccounts:onlogin");
    Services.obs.addObserver(this, "fxaccounts:onlogout");
    this._registered = true;
  },

  setComplete() {
    this._loggedIn = true;
    Services.prefs.setBoolPref("browser.onboarding.tour.onboarding-tour-sync.completed", true);
  },

  unregister() {
    if (!this._registered) {
      return;
    }
    Services.obs.removeObserver(this, "fxaccounts:onlogin");
    Services.obs.removeObserver(this, "fxaccounts:onlogout");
    this._registered = false;
  },

  uninit() {
    this.unregister();
  },
}

/**
 * Listen and process events from content.
 */
function initContentMessageListener() {
  Services.mm.addMessageListener("Onboarding:OnContentMessage", msg => {
    switch (msg.data.action) {
      case "set-prefs":
        setPrefs(msg.data.params);
        break;
      case "get-login-status":
        msg.target.messageManager.sendAsyncMessage("Onboarding:ResponseLoginStatus", {
          isLoggedIn: syncTourChecker.isLoggedIn()
        });
        break;
    }
  });
}

/**
 * onBrowserReady - Continues startup of the add-on after browser is ready.
 */
function onBrowserReady() {
  waitingForBrowserReady = false;

  OnboardingTourType.check();
  Services.mm.loadFrameScript("resource://onboarding/onboarding.js", true);
  initContentMessageListener();
}

/**
 * observe - nsIObserver callback to handle various browser notifications.
 */
function observe(subject, topic, data) {
  switch (topic) {
    case BROWSER_READY_NOTIFICATION:
      Services.obs.removeObserver(observe, BROWSER_READY_NOTIFICATION);
      onBrowserReady();
      break;
    case BROWSER_SESSION_STORE_NOTIFICATION:
      Services.obs.removeObserver(observe, BROWSER_SESSION_STORE_NOTIFICATION);
      syncTourChecker.init();
      break;
  }
}


async function startup(addonData, reason) {
  /* Shield's bootstrap */
  // addonData: Array [ "id", "version", "installPath", "resourceURI", "instanceID", "webExtension" ]  bootstrap.js:48
  log.debug("startup", REASONS[reason] || reason);
  studyUtils.setup({
    studyName: studyConfig.studyName,
    endings: studyConfig.endings,
    addon: {id: addonData.id, version: addonData.version},
    telemetry: studyConfig.telemetry,
  });
  studyUtils.setLoggingLevel(config.log.studyUtils.level);
  const variation = await chooseVariation();
  studyUtils.setVariation(variation);

  Jsm.import(config.modules);

  if ((REASONS[reason]) === "ADDON_INSTALL") {
    studyUtils.firstSeen();  // sends telemetry "enter"
    const eligible = await config.isEligible(); // addon-specific
    if (!eligible) {
      // uses config.endings.ineligible.url if any,
      // sends UT for "ineligible"
      // then uninstalls addon
      await studyUtils.endStudy({reason: "ineligible"});
      return;
    }
  }
  await studyUtils.startup({reason});

  console.log(`info ${JSON.stringify(studyUtils.info())}`);
  // if you have code to handle expiration / long-timers, it could go here.
  // studyUtils.endStudy("user-disable");
  /* Onboarding's bootstrap */
  if (reason === ADDON_INSTALL) {
    Services.prefs.deleteBranch("browser.onboarding");
    // Preferences for Photon onboarding system extension
    Services.prefs.setBoolPref("browser.onboarding.enabled", true);
    // Mark this as an upgraded profile so we don't offer the initial new user onboarding tour.
    Services.prefs.setIntPref("browser.onboarding.tourset-version", 1);
    Services.prefs.setBoolPref("browser.onboarding.hidden", false);
    // On the Activity-Stream page, the snippet's position overlaps with our notification.
    // So use `browser.onboarding.notification.finished` to let the AS page know
    // if our notification is finished and safe to show their snippet.
    Services.prefs.setBoolPref("browser.onboarding.notification.finished", false);
    Services.prefs.setStringPref("browser.onboarding.updatetour", "");
    // Preference that allows individual users to disable Screenshots.
    Services.prefs.setBoolPref("extensions.screenshots.disabled", false);

    let tourOrder;
    let impressions;
    let expires;
    let firstSessionDelay;
    switch(variation.name) {
    case "var1":
      tourOrder = "private,addons,customize,search,default,sync";
      impressions = 4;
      expires = 43200000;
      firstSessionDelay = 120000;
      break;
    case "var2":
      tourOrder = "private,search,addons,customize,default,sync";
      impressions = 4;
      expires = 43200000;
      firstSessionDelay = 120000;
      break;
    case "var3":
      tourOrder = "private,default,addons,customize,search,sync";
      impressions = 4;
      expires = 43200000;
      firstSessionDelay = 120000;
      break;
    case "var4":
      tourOrder = "private,default,addons,customize,search,sync";
      impressions = 2;
      expires = 21600000;
      firstSessionDelay = 60000;
      break;
    default:
      tourOrder = "private,addons,customize,search,default,sync";
      impressions = 4;
      expires = 86400000;
      firstSessionDelay = 300000;
      break;
    };
    Services.prefs.setIntPref("browser.onboarding.notification.mute-duration-on-first-session-ms", firstSessionDelay);
    Services.prefs.setIntPref("browser.onboarding.notification.max-life-time-per-tour-ms", expires);
    Services.prefs.setIntPref("browser.onboarding.notification.max-prompt-count-per-tour", impressions);
    Services.prefs.setStringPref("browser.onboarding.newtour", tourOrder);
  }
  // Only start Onboarding when the browser UI is ready
  if (Services.startup.startingUp) {
    Services.obs.addObserver(observe, BROWSER_READY_NOTIFICATION);
    Services.obs.addObserver(observe, BROWSER_SESSION_STORE_NOTIFICATION);
  } else {
    onBrowserReady();
    syncTourChecker.init();
  }
}


function shutdown(addonData, reason) {
  console.log("shutdown", REASONS[reason] || reason);
  // are we uninstalling?
  // if so, user or automatic?
  if (reason === REASONS.ADDON_UNINSTALL || reason === REASONS.ADDON_DISABLE) {
    console.log("uninstall or disable");
    if (!studyUtils._isEnding) {
      // we are the first requestors, must be user action.
      console.log("user requested shutdown");
      studyUtils.endStudy({reason: "user-disable"});
      return;
    }

  // normal shutdown, or 2nd attempts
    console.log("Jsms unloading");
    Jsm.unload(config.modules);
    Jsm.unload([CONFIGPATH, STUDYUTILSPATH]);
  }

  /* Onboarding works */
  // Stop waiting for browser to be ready
  if (waitingForBrowserReady) {
    Services.obs.removeObserver(observe, BROWSER_READY_NOTIFICATION);
  }
  syncTourChecker.uninit();
}

function uninstall(addonData, reason) {
  console.log("uninstall", REASONS[reason] || reason);
}

function install(addonData, reason) {
  console.log("install", REASONS[reason] || reason);
  // handle ADDON_UPGRADE (if needful) here
}

/** CONSTANTS and other bootstrap.js utilities */

// addon state change reasons
const REASONS = {
  APP_STARTUP: 1,      // The application is starting up.
  APP_SHUTDOWN: 2,     // The application is shutting down.
  ADDON_ENABLE: 3,     // The add-on is being enabled.
  ADDON_DISABLE: 4,    // The add-on is being disabled. (Also sent during uninstallation)
  ADDON_INSTALL: 5,    // The add-on is being installed.
  ADDON_UNINSTALL: 6,  // The add-on is being uninstalled.
  ADDON_UPGRADE: 7,    // The add-on is being upgraded.
  ADDON_DOWNGRADE: 8,  // The add-on is being downgraded.
};
for (const r in REASONS) { REASONS[REASONS[r]] = r; }

// logging
function createLog(name, levelWord) {
  Cu.import("resource://gre/modules/Log.jsm");
  var L = Log.repository.getLogger(name);
  L.addAppender(new Log.ConsoleAppender(new Log.BasicFormatter()));
  L.level = Log.Level[levelWord] || Log.Level.Debug; // should be a config / pref
  return L;
}

async function chooseVariation() {
  let toSet, source;
  const sample = studyUtils.sample;
  if (studyConfig.variation) {
    source = "startup-config";
    toSet = studyConfig.variation;
  } else {
    source = "weightedVariation";
    // this is the standard arm choosing method
    const clientId = await studyUtils.getTelemetryId();
    const hashFraction = await sample.hashFraction(studyConfig.studyName + clientId, 12);
    toSet = sample.chooseWeighted(studyConfig.weightedVariations, hashFraction);
  }
  log.debug(`variation: ${toSet} source:${source}`);
  return toSet;
}

// jsm loader / unloader
class Jsm {
  static import(modulesArray) {
    for (const module of modulesArray) {
      log.debug(`loading ${module}`);
      Cu.import(module);
    }
  }
  static unload(modulesArray) {
    for (const module of modulesArray) {
      log.debug(`Unloading ${module}`);
      Cu.unload(module);
    }
  }
}
