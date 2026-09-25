// Goal actions this browser may offer. Fail-closed until GET /api/auth/session
// answers: do not show create or resume and then hide them after a 403.
import { useEffect, useState } from "react";

import { goalCapabilities, readSessionState, type GoalCapabilities } from "./session";

const NONE: GoalCapabilities = { canCreate: false, canControl: false, canResume: false };
let pending: Promise<GoalCapabilities> | null = null;

function load(): Promise<GoalCapabilities> {
  pending ??= readSessionState().then(goalCapabilities, () => NONE);
  return pending;
}

export function useGoalCapabilities(): GoalCapabilities {
  const [allowed, setAllowed] = useState<GoalCapabilities>(NONE);
  useEffect(() => {
    let alive = true;
    void load().then((value) => {
      if (alive) setAllowed(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return allowed;
}
