import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { attemptsForCodes } from "@/lib/attempts";
import { formatCredits, slotCodeChoices } from "@/lib/courseMap";
import { attemptsQuery } from "@/lib/queries";
import { bestAttempt, gradeLabel, WAIVED } from "../../../shared/grading";
import type { CourseMap } from "../../../shared/schemas/courses";

type Category = CourseMap["categories"][number];
type Slot = Category["slots"][number];
type StudentCourse = CourseMap["extras"][number];
type CompletedItem = {
  key: string;
  code: string;
  title: string;
  category: string;
  credits: number;
  grade: string;
  target: { type: "slot"; slot: Slot } | { type: "extra"; course: StudentCourse };
};

/**
 * A readable transcript view derived from the same course map and attempts used for credit totals.
 * Selecting an item opens the existing course sheet, where students can add or edit its attempts.
 */
export function CompletedCourses({
  map,
  onSelect,
}: {
  map: CourseMap;
  onSelect: (target: CompletedItem["target"]) => void;
}) {
  const { data: attempts, isPending, isError } = useQuery(attemptsQuery);
  const records: CompletedItem[] = [];

  for (const category of map.categories) {
    for (const slot of category.slots) {
      if (slot.status !== "done") continue;
      const choices = slotCodeChoices(slot);
      const recorded = bestAttempt(attemptsForCodes(attempts ?? [], choices.map((c) => c.code)));
      const completedCode = slot.filledBy ?? slot.chosenCode ?? choices[0]?.code ?? slot.code;
      const selected = choices.find((choice) => choice.code === completedCode) ?? choices[0];
      records.push({
        key: `slot-${category.name}-${slot.code}`,
        code: selected?.code ?? completedCode,
        title: selected?.title ?? slot.title,
        category: category.name,
        credits: slot.credits,
        grade:
          recorded?.grade ??
          (slot.waived ? WAIVED : isPending ? "Loading…" : "Grade unavailable"),
        target: { type: "slot", slot },
      });
    }
  }

  for (const course of map.extras) {
    if (!course.done) continue;
    const recorded = bestAttempt(attemptsForCodes(attempts ?? [], [course.code]));
    records.push({
      key: `extra-${course.id}`,
      code: course.code,
      title: course.title,
      category: course.category,
      credits: course.credits,
      grade:
        recorded?.grade ??
        (course.waived ? WAIVED : isPending ? "Loading…" : "Grade unavailable"),
      target: { type: "extra", course },
    });
  }

  return (
    <section
      className="mb-6 overflow-hidden rounded-panel border border-line bg-surface"
      aria-labelledby="completed-courses-title"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 id="completed-courses-title" className="font-semibold text-ink">
            Completed courses
          </h2>
          <p className="text-sm text-soft">
            Passing grades fill the map and recalculate your CGPA.
          </p>
        </div>
        <span className="text-sm text-soft tabular-nums">{records.length} courses</span>
      </header>
      {records.length === 0 ? (
        <p className="px-4 py-5 text-sm text-soft">
          No courses completed yet. Choose a course from the map below to record its grade.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {records.map((record) => (
            <li key={record.key}>
              <Button
                type="button"
                variant="ghost"
                className="h-auto min-h-14 w-full justify-start rounded-none px-4 py-3 text-left"
                onClick={() => onSelect(record.target)}
                aria-label={`Edit ${record.code}, grade ${gradeLabel(record.grade)}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-ink">{record.code}</span>
                    <span className="truncate text-soft">{record.title}</span>
                  </span>
                  <span className="block text-sm text-soft">{record.category}</span>
                </span>
                <span className="shrink-0 text-right text-sm tabular-nums">
                  <span className="block font-semibold text-ink">{gradeLabel(record.grade)}</span>
                  <span className="text-soft">{formatCredits(record.credits)} cr</span>
                </span>
                <ChevronRightIcon className="ml-2 size-4 shrink-0 text-faint" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {isPending ? (
        <p className="sr-only" role="status">
          Loading grades
        </p>
      ) : null}
      {isError ? (
        <p className="border-t border-line px-4 py-2 text-sm text-soft" role="status">
          Course status loaded, but grade details could not be loaded. Try opening a course to
          refresh them.
        </p>
      ) : null}
    </section>
  );
}
