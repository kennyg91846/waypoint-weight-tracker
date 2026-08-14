// install.js — optional app install/download button behavior.
//
// Shows a header button when the browser exposes a PWA install prompt.
// On iOS Safari/Chrome (no beforeinstallprompt event), shows the button
// and provides basic "Add to Home Screen" instructions.

let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function getInstallButtons() {
  return Array.from(document.querySelectorAll('[data-install-app]'));
}

function setButtonsVisible(visible) {
  getInstallButtons().forEach((btn) => {
    btn.hidden = !visible;
  });
}

function isIOS() {
  const ua = window.navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua);
}

function wireButtonHandlers() {
  getInstallButtons().forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        try {
          await deferredInstallPrompt.userChoice;
        } catch {
          // Ignore prompt cancellation/errors.
        }
        deferredInstallPrompt = null;
        setButtonsVisible(false);
        return;
      }

      if (isIOS() && !isStandalone()) {
        window.alert('To install: tap Share, then Add to Home Screen.');
      }
    });
  });
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  setButtonsVisible(true);
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  setButtonsVisible(false);
});

window.addEventListener('DOMContentLoaded', () => {
  wireButtonHandlers();

  if (isStandalone()) {
    setButtonsVisible(false);
    return;
  }

  // iOS has no install prompt event; still surface the button as a hint.
  if (isIOS()) {
    setButtonsVisible(true);
  }
});
