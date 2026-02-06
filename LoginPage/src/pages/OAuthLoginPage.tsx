import React from 'react';
import { Box, Paper } from '@mui/material';
import { OAuthLoginForm } from '../components/OAuthLoginForm';
export function OAuthLoginPage() {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
        p: {
          xs: 2,
          md: 4
        }
      }}>

      {/* Full-page background image */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
          'url(https://cdn.magicpatterns.com/uploads/94NC27nbdKFZJnUMAiJT3K/BACK2.png)',
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          zIndex: 0
        }} />


      {/* Subtle overlay to ensure form readability */}
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'rgba(255, 255, 255, 0.15)',
          backdropFilter: 'blur(2px)',
          zIndex: 1
        }} />


      {/* White card with login form */}
      <Paper
        elevation={8}
        sx={{
          position: 'relative',
          zIndex: 2,
          width: '100%',
          maxWidth: 480,
          borderRadius: 4,
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          backdropFilter: 'blur(20px)',
          boxShadow:
          '0 25px 50px -12px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(255, 255, 255, 0.5)',
          p: {
            xs: 3,
            sm: 5
          }
        }}>

        <OAuthLoginForm />
      </Paper>
    </Box>);

}