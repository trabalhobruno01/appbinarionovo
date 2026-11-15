const serverUrl = process.env.CAPACITOR_SERVER_URL?.trim();

const config = {
  appId: 'br.com.chartpulse.app',
  appName: 'ChartPulse AI',
  webDir: 'dist',
  ...(serverUrl
    ? {
        server: {
          url: serverUrl,
          cleartext: false,
          androidScheme: 'https',
        },
      }
    : {
        server: {
          androidScheme: 'https',
        },
      }),
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    Camera: {
      presentationStyle: 'fullscreen',
    },
  },
};

export default config;
