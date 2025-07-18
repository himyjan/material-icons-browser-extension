import Browser from 'webextension-polyfill';
import { ProviderMap } from '@/models';
import { providerConfig } from '@/providers';

export async function guessProvider(tab: Browser.Tabs.Tab) {
  const possibilities: ProviderMap = {};

  for (const provider of Object.values(providerConfig)) {
    if (
      !provider.isCustom &&
      provider.canSelfHost &&
      provider.selectors.detect
    ) {
      possibilities[provider.name] = provider.selectors.detect;
    }
  }

  const cmd = {
    cmd: 'guessProvider',
    args: [possibilities],
  };

  return (await Browser.tabs.sendMessage(tab.id ?? 0, cmd)) ?? false;
}
