import type { StorybookConfig } from '@storybook/react-vite';

// Storybook uses the app's vite.config.ts automatically (react + tailwind +
// @ alias). Keep this file minimal — no custom framework options needed.
const config: StorybookConfig = {
  stories: ['../src/shared/ui/v2/**/*.stories.@(ts|tsx)'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
};

export default config;
