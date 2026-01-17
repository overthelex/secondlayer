import { Refine } from "@refinedev/core";
import { RefineThemes, ThemedLayoutV2, useNotificationProvider } from "@refinedev/antd";
import routerProvider, { NavigateToResource } from "@refinedev/react-router-v6";
import { BrowserRouter, Routes, Route, Outlet } from "react-router-dom";
import { ConfigProvider, App as AntApp } from "antd";
import { 
  FileText, 
  Database, 
  Search, 
  Settings,
  FileSearch,
  Layers
} from "lucide-react";

import { theme } from "./styles/theme";
import "./styles/global.css";
import { dataProvider } from "./providers";

// Pages
import { DocumentList, DocumentShow, DocumentEdit, DocumentCreate } from "./pages/documents";
import { QueryList, QueryShow } from "./pages/queries";
import { PatternList, PatternShow, PatternCreate } from "./pages/patterns";
import { Dashboard } from "./pages/dashboard";

// Icon wrapper for Lucide icons
const Icon = ({ icon: IconComponent, ...props }: any) => (
  <IconComponent size={18} strokeWidth={2} {...props} />
);

function App() {
  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000/api";
  
  return (
    <BrowserRouter
      future={{
        v7_startTransition: true,
        v7_relativeSplatPath: true,
      }}
    >
      <ConfigProvider theme={theme}>
        <AntApp>
          <Refine
            dataProvider={dataProvider(apiUrl)}
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
            ]}
            options={{
              syncWithLocation: true,
              warnWhenUnsavedChanges: true,
            }}
          >
            <Routes>
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
              </Route>
            </Routes>
          </Refine>
        </AntApp>
      </ConfigProvider>
    </BrowserRouter>
  );
}

export default App;
