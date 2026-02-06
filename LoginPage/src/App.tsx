import React from 'react';
import { OAuthLoginPage } from './pages/OAuthLoginPage';
import { createTheme, ThemeProvider, CssBaseline } from '@mui/material';
// Create a custom theme to match the design aesthetics
const theme = createTheme({
  typography: {
    fontFamily: '"Inter", "Roboto", "Helvetica", "Arial", sans-serif',
    button: {
      textTransform: 'none'
    }
  },
  palette: {
    primary: {
      main: '#000000'
    },
    background: {
      default: '#f3f4f6'
    }
  },
  shape: {
    borderRadius: 8
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          fontWeight: 600
        }
      }
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            borderRadius: 8
          }
        }
      }
    }
  }
});
export function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <OAuthLoginPage />
    </ThemeProvider>);

}