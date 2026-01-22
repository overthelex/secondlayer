import { Refine } from "@refinedev/core";
import { ThemedLayoutV2, useNotificationProvider } from "@refinedev/antd";
import routerProvider from "@refinedev/react-router-v6";
import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";
import { ConfigProvider, App as AntApp } from "antd";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  FileText,
  Database,
  Search,
  FileSearch,
  Layers,
  BookOpen
} from "lucide-react";

import { theme } from "./styles/theme";
import "./styles/global.css";
import { dataProvider } from "./providers";
import { authProvider } from "./providers/auth-provider";
import { AuthProvider } from "./contexts/AuthContext";
import { EULAProvider, useEULA } from "./contexts/EULAContext";
import { EULAModal } from "./components/EULAModal";
import { UserFooter } from "./components/UserFooter";

// Pages
import { DocumentList, DocumentShow, DocumentEdit, DocumentCreate } from "./pages/documents";
import { QueryList, QueryShow } from "./pages/queries";
import { PatternList, PatternShow, PatternCreate } from "./pages/patterns";
import { Dashboard } from "./pages/dashboard";
import { Login } from "./pages/auth";
import { HelpPage } from "./pages/help";

// Icon wrapper for Lucide icons
const Icon = ({ icon: IconComponent, ...props }: any) => (
  <IconComponent size={18} strokeWidth={2} {...props} />
);

// EULA Modal Wrapper - shows modal when needed
const EULAModalWrapper = () => {
  const { showModal, acceptEULA } = useEULA();

  return (
    <EULAModal
      open={showModal}
      onAccept={acceptEULA}
      requireAcceptance={true}
    />
  );
};

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function App() {
  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000/api";

  return (
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={theme}>
          <AntApp>
            <AuthProvider>
              <EULAProvider>
              <EULAModalWrapper />
              <Refine
              dataProvider={dataProvider(apiUrl)}
              authProvider={authProvider}
              routerProvider={routerProvider}
              notificationProvider={useNotificationProvider}
              resources={[
              {
                name: "dashboard",
                list: "/",
                meta: {
                  label: "Dashboard",
                  icon: <Icon icon={Layers} />,
                },
              },
              {
                name: "documents",
                list: "/documents",
                show: "/documents/:id",
                edit: "/documents/:id/edit",
                create: "/documents/create",
                meta: {
                  label: "Documents",
                  icon: <Icon icon={FileText} />,
                },
              },
              {
                name: "queries",
                list: "/queries",
                show: "/queries/:id",
                meta: {
                  label: "Queries",
                  icon: <Icon icon={Search} />,
                },
              },
              {
                name: "patterns",
                list: "/patterns",
                show: "/patterns/:id",
                create: "/patterns/create",
                meta: {
                  label: "Legal Patterns",
                  icon: <Icon icon={FileSearch} />,
                },
              },
              {
                name: "help",
                list: "/help",
                meta: {
                  label: "Help & Documentation",
                  icon: <Icon icon={BookOpen} />,
                },
              },
            ]}
            options={{
              syncWithLocation: true,
              warnWhenUnsavedChanges: true,
            }}
          >
            <Routes>
              {/* Login route (public) */}
              <Route path="/login" element={<Login />} />

              {/* Protected routes */}
              <Route
                element={
                  <ThemedLayoutV2
                    Title={({ collapsed }) => (
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: collapsed ? 0 : 12,
                        padding: '12px 0'
                      }}>
                        <Icon icon={Database} style={{ color: '#06b6d4' }} />
                        {!collapsed && (
                          <span style={{
                            fontWeight: 600,
                            fontSize: 16,
                            color: '#171717'
                          }}>
                            SecondLayer
                          </span>
                        )}
                      </div>
                    )}
                    Footer={() => <UserFooter />}
                  >
                    <Outlet />
                  </ThemedLayoutV2>
                }
              >
                <Route index element={<Dashboard />} />
                
                <Route path="/documents">
                  <Route index element={<DocumentList />} />
                  <Route path="create" element={<DocumentCreate />} />
                  <Route path=":id" element={<DocumentShow />} />
                  <Route path=":id/edit" element={<DocumentEdit />} />
                </Route>
                
                <Route path="/queries">
                  <Route index element={<QueryList />} />
                  <Route path=":id" element={<QueryShow />} />
                </Route>
                
                <Route path="/patterns">
                  <Route index element={<PatternList />} />
                  <Route path="create" element={<PatternCreate />} />
                  <Route path=":id" element={<PatternShow />} />
                </Route>

                <Route path="/help" element={<HelpPage />} />
              </Route>
            </Routes>
              </Refine>
            </EULAProvider>
          </AuthProvider>
        </AntApp>
      </ConfigProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}

export default App;
