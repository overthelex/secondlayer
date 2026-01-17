# SecondLayer Admin Panel

Modern admin panel for managing legal documents database built with React and Refine framework.

## Tech Stack

- **Framework**: [Refine](https://refine.dev/) - React-based framework for building admin panels
- **UI Library**: [Ant Design](https://ant.design/) - Enterprise-class UI design system
- **Icons**: [Lucide React](https://lucide.dev/) - Beautiful & consistent icon pack
- **Build Tool**: Vite
- **Language**: TypeScript
- **Router**: React Router v6

## Design System

### Color Palette
- **Primary**: Cyan (#06b6d4) - Main accent color
- **Monochrome**: Black (#171717), Dark Gray (#525252), Gray (#737373), Light Gray (#a3a3a3)
- **Background**: White (#ffffff), Light Gray (#fafafa), Very Light Gray (#f5f5f5)
- **Success**: Teal (#14b8a6)
- **Warning**: Amber (#f59e0b)
- **Error**: Red (#ef4444)

### Typography
- **Font Family**: System fonts (-apple-system, BlinkMacSystemFont, Segoe UI, Roboto)
- **Base Size**: 14px
- **Weights**: 400 (regular), 500 (medium), 600 (semibold)

## Features

- **Dashboard**: Overview with statistics and recent items
- **Documents Management**: CRUD operations for legal documents
- **Queries**: View and analyze search queries
- **Legal Patterns**: Manage legal citation and argument patterns
- **Responsive Design**: Works on desktop and mobile
- **Dark/Light Status Badges**: Color-coded status indicators
- **Search & Filter**: Quick search across all resources

## Getting Started

### Installation

```bash
cd frontend
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build for Production

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

## Project Structure

```
frontend/
├── src/
│   ├── pages/
│   │   ├── dashboard/       # Dashboard page
│   │   ├── documents/       # Document CRUD pages
│   │   ├── queries/         # Query list and details
│   │   └── patterns/        # Legal patterns management
│   ├── styles/
│   │   ├── theme.ts         # Ant Design theme config
│   │   └── global.css       # Global styles
│   ├── App.tsx              # Main app component with routes
│   └── main.tsx             # Entry point
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## API Integration

The app expects a REST API at `http://localhost:3000/api` with the following endpoints:

- `GET /api/documents` - List documents
- `GET /api/documents/:id` - Get single document
- `POST /api/documents` - Create document
- `PUT /api/documents/:id` - Update document
- `DELETE /api/documents/:id` - Delete document
- `GET /api/queries` - List queries
- `GET /api/patterns` - List patterns

## Customization

### Theme

Edit `src/styles/theme.ts` to customize colors, spacing, and component styles.

### Icons

All icons use Lucide React. Browse available icons at [lucide.dev](https://lucide.dev/).

To use a new icon:

```tsx
import { IconName } from 'lucide-react';

<IconName size={18} color="#06b6d4" />
```

### Adding New Pages

1. Create page component in `src/pages/`
2. Add route in `src/App.tsx`
3. Add resource to Refine config with icon and navigation

## License

MIT
