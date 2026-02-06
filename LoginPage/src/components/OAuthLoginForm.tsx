import React, { useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Checkbox,
  FormControlLabel,
  InputAdornment,
  IconButton,
  Link,
  Stack } from
'@mui/material';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
// Google Icon SVG component
const GoogleIcon = () =>
<svg
  width="20"
  height="20"
  viewBox="0 0 24 24"
  xmlns="http://www.w3.org/2000/svg">

    <path
    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
    fill="#4285F4" />

    <path
    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    fill="#34A853" />

    <path
    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
    fill="#FBBC05" />

    <path
    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
    fill="#EA4335" />

  </svg>;

export function OAuthLoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    // Simulate API call
    console.log({
      email,
      password,
      rememberMe
    });
    setTimeout(() => setIsLoading(false), 1500);
  };
  return (
    <Box
      component="form"
      onSubmit={handleSubmit}
      sx={{
        width: '100%',
        maxWidth: 400,
        mx: 'auto',
        p: 2
      }}>

      <Box mb={4}>
        <Typography
          variant="h4"
          component="h1"
          fontWeight="bold"
          gutterBottom
          sx={{
            color: '#1a1a1a'
          }}>

          Welcome back
        </Typography>
        <Typography variant="body1" color="text.secondary">
          MCP legal.org.ua — OAuth2 Authorization
        </Typography>
      </Box>

      <Stack spacing={3}>
        <Box>
          <Typography
            variant="subtitle2"
            fontWeight="600"
            mb={1}
            sx={{
              color: '#333'
            }}>

            Email
          </Typography>
          <TextField
            fullWidth
            placeholder="Email Address"
            variant="outlined"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            sx={{
              '& .MuiOutlinedInput-root': {
                borderRadius: 2,
                backgroundColor: '#f9fafb',
                '& fieldset': {
                  borderColor: '#e5e7eb'
                },
                '&:hover fieldset': {
                  borderColor: '#d1d5db'
                },
                '&.Mui-focused fieldset': {
                  borderColor: '#1a1a1a'
                }
              }
            }} />

        </Box>

        <Box>
          <Typography
            variant="subtitle2"
            fontWeight="600"
            mb={1}
            sx={{
              color: '#333'
            }}>

            Password
          </Typography>
          <TextField
            fullWidth
            placeholder="Password 8-16 characters"
            type={showPassword ? 'text' : 'password'}
            variant="outlined"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            InputProps={{
              endAdornment:
              <InputAdornment position="end">
                  <IconButton
                  aria-label="toggle password visibility"
                  onClick={() => setShowPassword(!showPassword)}
                  edge="end"
                  size="small">

                    {showPassword ?
                  <EyeOffIcon size={20} color="#9ca3af" /> :

                  <EyeIcon size={20} color="#9ca3af" />
                  }
                  </IconButton>
                </InputAdornment>

            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                borderRadius: 2,
                backgroundColor: '#f9fafb',
                '& fieldset': {
                  borderColor: '#e5e7eb'
                },
                '&:hover fieldset': {
                  borderColor: '#d1d5db'
                },
                '&.Mui-focused fieldset': {
                  borderColor: '#1a1a1a'
                }
              }
            }} />

        </Box>

        <Box display="flex" justifyContent="space-between" alignItems="center">
          <FormControlLabel
            control={
            <Checkbox
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              sx={{
                color: '#d1d5db',
                '&.Mui-checked': {
                  color: '#1a1a1a'
                }
              }} />

            }
            label={
            <Typography variant="body2" color="text.secondary">
                Remember me
              </Typography>
            } />

          <Link
            href="#"
            underline="hover"
            sx={{
              color: '#1a1a1a',
              fontWeight: 600,
              fontSize: '0.875rem'
            }}>

            Forgot Password?
          </Link>
        </Box>

        <Button
          type="submit"
          fullWidth
          variant="contained"
          disabled={isLoading}
          sx={{
            bgcolor: '#000',
            color: '#fff',
            py: 1.5,
            borderRadius: 2,
            textTransform: 'none',
            fontSize: '1rem',
            fontWeight: 600,
            boxShadow:
            '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
            '&:hover': {
              bgcolor: '#333',
              boxShadow:
              '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)'
            },
            '&:disabled': {
              bgcolor: '#666'
            }
          }}>

          {isLoading ? 'Authorizing...' : 'Authorize'}
        </Button>

        <Button
          fullWidth
          variant="outlined"
          startIcon={<GoogleIcon />}
          sx={{
            borderColor: '#e5e7eb',
            color: '#374151',
            py: 1.5,
            borderRadius: 2,
            textTransform: 'none',
            fontSize: '1rem',
            fontWeight: 500,
            bgcolor: '#fff',
            '&:hover': {
              borderColor: '#d1d5db',
              bgcolor: '#f9fafb'
            }
          }}>

          Continue with Google
        </Button>

        <Box textAlign="center" mt={2}>
          <Typography variant="body2" color="text.secondary">
            Don't have an account?{' '}
            <Link
              href="#"
              underline="hover"
              sx={{
                color: '#1a1a1a',
                fontWeight: 700
              }}>

              Sign Up
            </Link>
          </Typography>
        </Box>
      </Stack>
    </Box>);

}