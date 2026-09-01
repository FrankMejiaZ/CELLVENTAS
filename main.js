// ==========================================
// Proceso Principal de Electron.js (Desktop App)
// VT VALETEC Standard Native Launcher
// ==========================================
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

// Iniciar servidor Express Backend
const server = require('./server');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 768,
    minWidth: 1024,
    minHeight: 700,
    title: 'VALEVENTAS by VT VALETEC - Sistema POS & Fiados',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Ocultar la barra de menú predeterminada de Electron
  Menu.setApplicationMenu(null);

  // Cargar la URL local servida por Express
  setTimeout(() => {
    mainWindow.loadURL('http://localhost:8090');
  }, 1200);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
