import type { Preview } from '@storybook/react-vite';
import '@/shared/ui/tokens.css';

const preview: Preview = {
  decorators: [
    (Story) => (
      <div className="ml2 min-h-[400px] w-full max-w-2xl p-8">
        <Story />
      </div>
    ),
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
  },
};

export default preview;
