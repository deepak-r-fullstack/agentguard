import { Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "components/layout/AppLayout";
import { DisplayToasts } from "components/display_components";
import { useAuthStore } from "utils/store/authStore";
import { UserRole } from "utils/types";
import { LoginScreen } from "screens/login_screen";
import { ApprovalsScreen } from "screens/approvals_screen";
import { ActivityScreen } from "screens/activity_screen";
import { RulesScreen } from "screens/rules_screen";
import { PlaygroundScreen } from "screens/playground_screen";
import { CompanyScreen } from "screens/company_screen";
import { AuditScreen } from "screens/audit_screen";
import { AgentsScreen } from "screens/agents_screen";
import { ConnectionsScreen } from "screens/connections_screen";

const RequireRole = ({ roles, children }: { roles: UserRole[]; children: JSX.Element }) => {
  const user = useAuthStore((state) => state.user);
  return user && roles.includes(user.role) ? children : <Navigate to="/approvals" replace />;
};

export const App = () => {
  const token = useAuthStore((state) => state.token);

  return (
    <>
      {token ? (
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/approvals" element={<ApprovalsScreen />} />
            <Route path="/activity" element={<ActivityScreen />} />
            <Route path="/rules" element={<RulesScreen />} />
            <Route
              path="/playground"
              element={
                <RequireRole roles={["admin", "manager"]}>
                  <PlaygroundScreen />
                </RequireRole>
              }
            />
            <Route path="/company" element={<CompanyScreen />} />
            <Route path="/audit" element={<AuditScreen />} />
            <Route
              path="/agents"
              element={
                <RequireRole roles={["admin"]}>
                  <AgentsScreen />
                </RequireRole>
              }
            />
            <Route
              path="/connections"
              element={
                <RequireRole roles={["admin"]}>
                  <ConnectionsScreen />
                </RequireRole>
              }
            />
            <Route path="*" element={<Navigate to="/approvals" replace />} />
          </Route>
        </Routes>
      ) : (
        <Routes>
          <Route path="*" element={<LoginScreen />} />
        </Routes>
      )}
      <DisplayToasts />
    </>
  );
};
