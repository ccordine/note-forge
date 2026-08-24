import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { useAppNavigation } from "@/routing/use-app-navigation";
import {
  PAGE_TITLES,
  PRACTICE_ACTIVITIES,
  appRouteScreen,
  type AppRoute,
  type PracticeActivity,
} from "@/navigation";

const ACTIVITIES = {
  "pitch-match": lazy(() => import("@/features/pitch-mirror/PitchMirror").then((module) => ({ default: module.PitchMirror }))),
  "pitch-tunnel": lazy(() => import("@/features/pitch-tunnel/PitchTunnel").then((module) => ({ default: module.PitchTunnel }))),
  hum: lazy(() => import("@/features/hum-lab/HumLab").then((module) => ({ default: module.HumLab }))),
  "range-loop": lazy(() => import("@/features/range-loop/RangeLoop").then((module) => ({ default: module.RangeLoop }))),
  "pitch-control": lazy(() => import("@/features/pitch-control/PitchControl").then((module) => ({ default: module.PitchControl }))),
  "note-recognition": lazy(() => import("@/features/ear-training/EarLab").then((module) => ({ default: module.EarLab }))),
  intervals: lazy(() => import("@/features/intervals/IntervalLab").then((module) => ({ default: module.IntervalLab }))),
  harmony: lazy(() => import("@/features/harmony/HarmonyLab").then((module) => ({ default: module.HarmonyLab }))),
  melody: lazy(() => import("@/features/melody/MelodyLab").then((module) => ({ default: module.MelodyLab }))),
} satisfies Record<PracticeActivity, LazyExoticComponent<ComponentType>>;

function ActivityLoading({ title }: { title: string }) {
  return <div className="route-loading" role="status"><span /> Loading {title}…</div>;
}

function ActivitySelector({ route, navigate }: {
  route: Extract<AppRoute, { surface: "practice" }>;
  navigate: (route: AppRoute) => void;
}) {
  return (
    <div className="surface-navigation">
      <label>
        <span>Practice activity</span>
        <select
          aria-label="Practice activity"
          value={route.activity}
          onChange={(event) => {
            const activity = PRACTICE_ACTIVITIES.find((item) => item.id === event.target.value);
            if (activity) navigate(activity.route);
          }}
        >
          {PRACTICE_ACTIVITIES.map((activity) => <option key={activity.id} value={activity.id}>{activity.label}</option>)}
        </select>
      </label>
    </div>
  );
}

export function Practice() {
  const { route, navigate } = useAppNavigation();
  if (route.surface !== "practice") return null;
  const Activity = ACTIVITIES[route.activity];
  const title = PAGE_TITLES[appRouteScreen(route)].title;
  return (
    <>
      <ActivitySelector route={route} navigate={navigate} />
      <Suspense fallback={<ActivityLoading title={title} />}><Activity /></Suspense>
    </>
  );
}
