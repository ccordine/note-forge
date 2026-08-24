import { useCallback, useMemo } from "react";
import {
  matchRoutes,
  useLocation,
  useNavigate,
  type RouteObject,
} from "react-router";
import {
  ALL_APP_ROUTES,
  DEFAULT_ROUTES,
  appRoutePath,
  type AppRoute,
} from "@/navigation";

interface AppRouteHandle {
  readonly appRoute: AppRoute;
}

const APP_ROUTE_MATCHERS: RouteObject[] = ALL_APP_ROUTES.map((route) => Object.freeze({
  path: appRoutePath(route),
  caseSensitive: true,
  handle: Object.freeze({ appRoute: route } satisfies AppRouteHandle),
}));

export function matchAppRoute(pathname: string): AppRoute | null {
  const matches = matchRoutes(APP_ROUTE_MATCHERS, { pathname });
  const handle = matches?.at(-1)?.route.handle as AppRouteHandle | undefined;
  return handle?.appRoute ?? null;
}

export interface AppNavigation {
  readonly route: AppRoute;
  readonly valid: boolean;
  readonly navigate: (route: AppRoute, options?: Readonly<{ replace?: boolean }>) => void;
}

export function useAppNavigation(): AppNavigation {
  const location = useLocation();
  const routerNavigate = useNavigate();
  const matchedRoute = useMemo(() => matchAppRoute(location.pathname), [location.pathname]);
  const navigate = useCallback((route: AppRoute, options?: Readonly<{ replace?: boolean }>) => {
    void routerNavigate(appRoutePath(route), { replace: options?.replace });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [routerNavigate]);

  return useMemo(() => ({
    route: matchedRoute ?? DEFAULT_ROUTES.home,
    valid: matchedRoute !== null,
    navigate,
  }), [matchedRoute, navigate]);
}
