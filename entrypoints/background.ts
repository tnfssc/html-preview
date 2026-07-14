import { browser } from 'wxt/browser';

export default defineBackground(() => {
  void browser.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  });
});
