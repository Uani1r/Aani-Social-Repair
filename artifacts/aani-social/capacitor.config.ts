import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.aani.social',
  appName: 'Aani Social',
  webDir: 'dist/public',
  server: {
    androidScheme: 'https',
  },
};

export default config;