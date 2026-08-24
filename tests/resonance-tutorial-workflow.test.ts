import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ResonanceLessonProgress,
  ResonanceTutorialPath,
} from "../apps/web/src/features/voice-arcade/ResonanceTutorialUI";
import {
  createResonanceTutorialCurriculum,
} from "../apps/web/src/features/voice-arcade/resonance-tutorial";
import {
  createDefaultResonanceTutorialProgress,
  recordResonanceTutorialAttempt,
} from "../apps/web/src/features/voice-arcade/resonance-tutorial-progress";
import {
  createResonanceTutorialPathCards,
} from "../apps/web/src/features/voice-arcade/resonance-tutorial-view";

describe("Resonance onboarding model and rendered path", () => {
  it("renders only model-unlocked puzzles as controls", () => {
    const curriculum = createResonanceTutorialCurriculum({ baselineMidi: 48 });
    const progress = createDefaultResonanceTutorialProgress();
    const cards = createResonanceTutorialPathCards(curriculum, progress, "force-discover");
    const markup = renderToStaticMarkup(createElement(ResonanceTutorialPath, {
      mechanics: cards,
      completedPuzzles: 0,
      totalPuzzles: 12,
      onSelectPuzzle: () => undefined,
    }));

    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup.match(/aria-disabled="true"/g)).toHaveLength(11);
    expect(markup).toContain("0/12");
    expect(markup).toContain("Discover · Voice energy creates force");
  });

  it("renders exactly one active lesson phase", () => {
    const markup = renderToStaticMarkup(createElement(ResonanceLessonProgress, {
      activePuzzleIndex: 1,
      completedPuzzleCount: 1,
    }));

    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup.match(/class="complete"/g)).toHaveLength(1);
    expect(markup.match(/class="current"/g)).toHaveLength(1);
    expect(markup.match(/class="pending"/g)).toHaveLength(1);
  });

  it("derives one current lesson and locks all later puzzles until proof exists", () => {
    const curriculum = createResonanceTutorialCurriculum({ baselineMidi: 48 });
    let progress = createDefaultResonanceTutorialProgress();
    let cards = createResonanceTutorialPathCards(curriculum, progress, "force-discover");
    const initialPuzzles = cards.flatMap((card) => card.puzzles);

    expect(initialPuzzles.filter((puzzle) => puzzle.state === "current").map((puzzle) => puzzle.id))
      .toEqual(["force-discover"]);
    expect(initialPuzzles.filter((puzzle) => puzzle.state === "locked")).toHaveLength(11);

    progress = recordResonanceTutorialAttempt(progress, {
      lessonId: "force-discover",
      passed: true,
      score: 100,
    }, "2026-08-23T13:00:00.000Z");
    cards = createResonanceTutorialPathCards(curriculum, progress, "force-control");
    const nextPuzzles = cards.flatMap((card) => card.puzzles);
    expect(nextPuzzles.find((puzzle) => puzzle.id === "force-discover")?.state).toBe("complete");
    expect(nextPuzzles.find((puzzle) => puzzle.id === "force-control")?.state).toBe("current");
    expect(nextPuzzles.find((puzzle) => puzzle.id === "force-apply")?.state).toBe("locked");
  });
});
