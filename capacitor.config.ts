import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'za.co.mavholaparish.app',
  appName: 'ELCSA Mavhola Parish',
  webDir: 'public',
  server: {
    url: 'https://mavholaparish.co.za',
    cleartext: false,
    androidScheme: 'https'
  },
  plugins: {
    Share: {
      permissions: []
    }
  }
};

export default config;
