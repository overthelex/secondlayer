import type { ThemeConfig } from 'antd';

export const theme: ThemeConfig = {
  token: {
    // Monochrome + Cyan accent
    colorPrimary: '#06b6d4', // Cyan-500
    colorInfo: '#06b6d4',
    colorSuccess: '#14b8a6', // Teal-500
    colorWarning: '#f59e0b', // Amber-500
    colorError: '#ef4444', // Red-500
    
    // Monochrome base
    colorBgBase: '#ffffff',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#fafafa',
    colorBgLayout: '#f5f5f5',
    
    colorText: '#171717', // Neutral-900
    colorTextSecondary: '#525252', // Neutral-600
    colorTextTertiary: '#737373', // Neutral-500
    colorTextQuaternary: '#a3a3a3', // Neutral-400
    
    colorBorder: '#e5e5e5', // Neutral-200
    colorBorderSecondary: '#f5f5f5', // Neutral-100
    
    // Typography
    fontSize: 14,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    
    // Spacing
    borderRadius: 6,
    
    // Layout
    controlHeight: 36,
  },
  components: {
    Layout: {
      headerBg: '#ffffff',
      headerPadding: '0 24px',
      headerHeight: 64,
      siderBg: '#fafafa',
      bodyBg: '#f5f5f5',
    },
    Menu: {
      itemBg: 'transparent',
      itemSelectedBg: '#e0f2fe', // Cyan-100
      itemSelectedColor: '#0891b2', // Cyan-600
      itemHoverBg: '#f0f9ff', // Cyan-50
      itemHoverColor: '#06b6d4',
      iconSize: 18,
    },
    Table: {
      headerBg: '#fafafa',
      headerColor: '#171717',
      rowHoverBg: '#f0f9ff',
    },
    Button: {
      controlHeight: 36,
      fontWeight: 500,
    },
    Card: {
      headerBg: '#fafafa',
      boxShadowTertiary: '0 1px 2px 0 rgba(0, 0, 0, 0.03), 0 1px 6px -1px rgba(0, 0, 0, 0.02), 0 2px 4px 0 rgba(0, 0, 0, 0.02)',
    },
  },
};
