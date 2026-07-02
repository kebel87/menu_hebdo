import { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  UtensilsCrossed,
  BarChart2,
  Settings,
  Plus,
  X,
  Search,
  RefreshCw,
  Trash2,
  CheckCircle,
  Bell,
  BellOff,
  Filter,
} from "lucide-react";
import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface CurrentUser {
  subject: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
}

interface MealSlot {
  id: string;
  plan_id: string;
  slot_date: string;
  recipe_source: "mealie" | "local" | "free";
  mealie_slug?: string;
  local_recipe_id?: string;
  recipe_name: string;
  makes_lunch: boolean;
  notes: string;
  sides: SlotSide[];
  tags: CanonicalTag[];
  inventory_score?: {
    score: number | null;
    missing: string[];
    available: string[];
  };
}

interface SlotSide {
  id: string;
  side_id?: string;
  name: string;
  free_text: string;
  category: string;
  sort_order: number;
}

interface MealPlan {
  id: string;
  week_start: string;
  created_at: string;
}

interface Recipe {
  source: "mealie" | "local";
  id?: string;
  slug?: string;
  name: string;
  tags: CanonicalTag[];
  tag_ids?: string[];
  is_weekend: boolean;
  makes_lunch: boolean;
  is_hidden: boolean;
  prep_minutes?: number;
  notes: string;
  image?: string;
  inventory_score?: {
    score: number | null;
    missing: string[];
    available: string[];
  };
}

interface Side {
  id: string;
  name: string;
  category: string;
}

interface FavoriteSide {
  name: string;
  side_id?: string;
  category: string;
}

interface CanonicalTag {
  id: string;
  name: string;
  description: string;
  color: string;
  is_filter: boolean;
}

interface TagMapping {
  mealie_tag_name: string;
  canonical_tag_id?: string;
  canonical_tag_name?: string;
  status: "pending" | "confirmed" | "ignored";
}

interface HistoryResult {
  id: string;
  slot_date: string;
  recipe_name: string;
  week_start: string;
}

interface FreqEntry {
  recipe_name: string;
  count: number;
  last_date: string;
}

type ViewMode = "week" | "recipes" | "stats" | "settings";

const DAYS_FR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const DAYS_FULL = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const DEFAULT_TAG_COLOR = "#94a3b8";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function readableTextColor(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#242826" : "#ffffff";
}

function useFilterableTags(): CanonicalTag[] {
  const [tags, setTags] = useState<CanonicalTag[]>([]);
  useEffect(() => {
    api<CanonicalTag[]>("/api/tags")
      .then((t) => setTags(t.filter((x) => x.is_filter).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);
  return tags;
}

function hasTag(r: Recipe, tagId: string): boolean {
  return r.tags.some((t) => t.id === tagId);
}

function mondayOf(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addWeeks(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n * 7);
  return r;
}

function shiftMonth(c: { year: number; month: number }, delta: number): { year: number; month: number } {
  const d = new Date(c.year, c.month - 1 + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function weekDates(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function fmtWeekLabel(monday: Date): string {
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return `${monday.getDate()} ${MONTHS_FR[monday.getMonth()]} — ${sunday.getDate()} ${MONTHS_FR[sunday.getMonth()]} ${sunday.getFullYear()}`;
}

function fmtDateFull(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return `${DAYS_FULL[d.getDay() === 0 ? 6 : d.getDay() - 1]} ${d.getDate()} ${MONTHS_FR[d.getMonth()]} ${d.getFullYear()}`;
}

function weeksAgo(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const now = new Date();
  const diff = Math.floor((now.getTime() - d.getTime()) / (7 * 24 * 3600 * 1000));
  if (diff === 0) return "cette sem.";
  if (diff === 1) return "la sem. passée";
  return `il y a ${diff} sem.`;
}

function scoreClass(score: number | null | undefined): string {
  if (score === null || score === undefined) return "";
  if (score >= 0.8) return "badge-score-ok";
  if (score >= 0.5) return "badge-score-warn";
  return "badge-score-bad";
}

function scoreLabel(score: number | null | undefined): string {
  if (score === null || score === undefined) return "";
  if (score >= 0.8) return "✓";
  if (score >= 0.5) return "⚠";
  return "✗";
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────

function DraggableCard({
  slotDate,
  slot,
  children,
}: {
  slotDate: string;
  slot?: MealSlot;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: slotDate,
    data: { slot },
    disabled: !slot,
  });
  return (
    <div
      ref={setNodeRef}
      {...(slot ? { ...listeners, ...attributes } : {})}
      className={`day-card${isDragging ? " is-dragging" : ""}`}
    >
      {children}
    </div>
  );
}

function DroppableCard({
  slotDate,
  isOver,
  children,
}: {
  slotDate: string;
  isOver: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: `drop-${slotDate}` });
  return (
    <div ref={setNodeRef} className={`day-card${isOver ? " dragging-over" : ""}`}>
      {children}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [view, setView] = useState<ViewMode>("week");
  const [error, setError] = useState("");

  const canEdit = user?.permissions.includes("menu.edit") ?? false;
  const canAdmin = user?.permissions.includes("settings.manage") ?? false;

  useEffect(() => {
    api<CurrentUser>("/api/me")
      .then(setUser)
      .catch(() => setError("Impossible de charger le profil utilisateur."));
  }, []);

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="title-block">
          <h1>Menus de la semaine</h1>
          {user && <div className="subtitle">{user.name}</div>}
        </div>
      </div>
      <div className="nav-bar">
        <ul className="segmented">
          {(
            [
              { id: "week", label: "Semaine", icon: <CalendarDays size={14} /> },
              { id: "recipes", label: "Repas", icon: <UtensilsCrossed size={14} /> },
              { id: "stats", label: "Stats", icon: <BarChart2 size={14} /> },
              { id: "settings", label: "Paramètres", icon: <Settings size={14} /> },
            ] as { id: ViewMode; label: string; icon: React.ReactNode }[]
          ).map((tab) => (
            <li key={tab.id}>
              <button
                className={view === tab.id ? "active" : ""}
                onClick={() => setView(tab.id)}
              >
                {tab.icon} {tab.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="main-content">
        {view === "week" && <WeekScreen canEdit={canEdit} />}
        {view === "recipes" && <RecipesScreen canEdit={canEdit} />}
        {view === "stats" && <StatsScreen />}
        {view === "settings" && <SettingsScreen canAdmin={canAdmin} canEdit={canEdit} />}
      </div>
    </div>
  );
}

// ─── WeekScreen ───────────────────────────────────────────────────────────────

function WeekScreen({ canEdit }: { canEdit: boolean }) {
  const today = new Date();
  const [monday, setMonday] = useState<Date>(() => mondayOf(today));
  const [plan, setPlan] = useState<MealPlan | null>(null);
  const [slots, setSlots] = useState<MealSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [dayActionDate, setDayActionDate] = useState<string | null>(null);
  const [wizard, setWizard] = useState<{ date: string; mode: WizardMode } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"week" | "month">("week");
  const [monthCursor, setMonthCursor] = useState(() => ({
    year: today.getFullYear(),
    month: today.getMonth() + 1,
  }));
  const [monthSlots, setMonthSlots] = useState<MealSlot[]>([]);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  const weekStart = toIso(monday);
  const isCurrentWeek = weekStart === toIso(mondayOf(today));
  const dates = weekDates(monday);

  const loadWeek = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ plan: MealPlan; slots: MealSlot[] }>(`/api/week/${weekStart}`);
      setPlan(data.plan);
      setSlots(data.slots);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => { loadWeek(); }, [loadWeek]);

  const loadMonth = useCallback(async () => {
    try {
      const data = await api<{ slots: MealSlot[] }>(
        `/api/month/${monthCursor.year}/${monthCursor.month}`
      );
      setMonthSlots(data.slots);
    } catch {
      // silent
    }
  }, [monthCursor]);

  useEffect(() => {
    if (viewMode === "month") loadMonth();
  }, [viewMode, loadMonth]);

  const slotByDate = (iso: string) => slots.find((s) => s.slot_date === iso);

  function jumpToDate(iso: string) {
    setMonday(mondayOf(new Date(iso + "T00:00:00")));
    setViewMode("week");
    setShowDatePicker(false);
  }

  async function handleDragEnd(ev: DragEndEvent) {
    setActiveId(null);
    setOverId(null);
    const overDropId = ev.over?.id as string | undefined;
    if (!overDropId) return;
    const dateB = overDropId.replace("drop-", "");
    const dateA = ev.active.id as string;
    if (dateA === dateB) return;
    const slotA = slotByDate(dateA);
    const slotB = slotByDate(dateB);
    if (!slotA) return;
    if (!slotB) {
      // déplace vers un slot vide → change juste la date du slot A (même id,
      // donc les accompagnements associés suivent)
      try {
        const updated = await api<MealSlot>("/api/slots/move", {
          method: "POST",
          body: JSON.stringify({ slot_id: slotA.id, new_date: dateB }),
        });
        setSlots((prev) => [
          ...prev.filter((s) => s.slot_date !== dateA && s.slot_date !== dateB),
          updated,
        ]);
      } catch {}
      return;
    }
    try {
      const res = await api<{ slot_a: MealSlot; slot_b: MealSlot }>("/api/slots/swap", {
        method: "POST",
        body: JSON.stringify({ slot_id_a: slotA.id, slot_id_b: slotB.id }),
      });
      setSlots((prev) => [
        ...prev.filter((s) => s.slot_date !== dateA && s.slot_date !== dateB),
        res.slot_a,
        res.slot_b,
      ]);
    } catch {}
  }

  async function handleClear(slotDate: string) {
    try {
      await api(`/api/week/${weekStart}/slot/${slotDate}`, { method: "DELETE" });
      setSlots((prev) => prev.filter((s) => s.slot_date !== slotDate));
    } catch {}
  }

  // Persiste le choix du wizard : recipe=null -> ne touche pas au repas,
  // sides=null -> ne touche pas aux accompagnements.
  async function handleWizardComplete(slotDate: string, recipe: Recipe | null, sides: SlotSide[] | null) {
    try {
      let updated: MealSlot | null = null;
      if (recipe) {
        const body: Record<string, unknown> = {
          recipe_source: recipe.source,
          recipe_name: recipe.name,
          makes_lunch: recipe.makes_lunch,
        };
        if (recipe.source === "mealie") body.mealie_slug = recipe.slug;
        if (recipe.source === "local") body.local_recipe_id = recipe.id;
        updated = await api<MealSlot>(`/api/week/${weekStart}/slot/${slotDate}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        setSlots((prev) => [...prev.filter((s) => s.slot_date !== slotDate), updated!]);
      }
      if (sides !== null) {
        const slotId = updated?.id ?? slotByDate(slotDate)?.id;
        if (slotId) {
          const savedSides = await api<SlotSide[]>(`/api/slots/${slotId}/sides`, {
            method: "PUT",
            body: JSON.stringify(sides.map((s) => ({ side_id: s.side_id, free_text: s.free_text || s.name }))),
          });
          setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, sides: savedSides } : s)));
        }
      }
    } catch {}
    setWizard(null);
  }

  return (
    <div className="week-screen">
      <div className="week-nav">
        <button
          onClick={() =>
            viewMode === "week"
              ? setMonday((m) => addWeeks(m, -1))
              : setMonthCursor((c) => shiftMonth(c, -1))
          }
        >
          <ChevronLeft size={16} />
        </button>
        <button className="week-label" onClick={() => setShowDatePicker(true)}>
          {viewMode === "week" ? fmtWeekLabel(monday) : `${MONTHS_FR[monthCursor.month - 1]} ${monthCursor.year}`}
        </button>
        {viewMode === "week" && !isCurrentWeek && (
          <button className="today-btn" onClick={() => setMonday(mondayOf(today))}>
            Aujourd'hui
          </button>
        )}
        <button
          onClick={() =>
            viewMode === "week"
              ? setMonday((m) => addWeeks(m, 1))
              : setMonthCursor((c) => shiftMonth(c, 1))
          }
        >
          <ChevronRight size={16} />
        </button>
        <button
          className="btn-icon"
          title={viewMode === "week" ? "Vue mensuelle" : "Vue semaine"}
          onClick={() => setViewMode((v) => (v === "week" ? "month" : "week"))}
        >
          <CalendarDays size={16} />
        </button>
      </div>

      {viewMode === "month" ? (
        <MonthGrid
          year={monthCursor.year}
          month={monthCursor.month}
          slots={monthSlots}
          onSelectDay={jumpToDate}
        />
      ) : (
      <DndContext
        sensors={sensors}
        onDragStart={(e: DragStartEvent) => setActiveId(e.active.id as string)}
        onDragOver={(e) => setOverId(e.over?.id as string ?? null)}
        onDragEnd={handleDragEnd}
      >
        <div className="week-grid">
          {dates.map((d, i) => {
            const iso = toIso(d);
            const slot = slotByDate(iso);
            const isToday = iso === toIso(today);
            const isOver = overId === `drop-${iso}`;
            const openPicker = () => {
              if (!canEdit) return;
              if (slot) setDayActionDate(iso);
              else setWizard({ date: iso, mode: "new" });
            };

            return (
              <DroppableCard key={iso} slotDate={iso} isOver={isOver}>
                <DraggableCard slotDate={iso} slot={slot}>
                  <div
                    className={`day-card-header dow-${i}${isToday ? " today" : ""}`}
                    onClick={openPicker}
                  >
                    <span className="day-name">{DAYS_FR[i]}</span>
                    <span className="day-date">{d.getDate()}</span>
                    {canEdit && slot && (
                      <button
                        className="btn-icon"
                        style={{ marginLeft: "auto" }}
                        onClick={(e) => { e.stopPropagation(); handleClear(iso); }}
                        title="Retirer"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </div>
                  <div className={`day-card-body${!slot ? " empty" : ""}`} onClick={openPicker}>
                    <div className="meal-info">
                      <span className="meal-name">
                        {slot ? slot.recipe_name : "— "}
                      </span>
                      {slot && slot.sides.length > 0 && (
                        <span className="meal-sides">
                          {slot.sides.map((s) => s.name).join(", ")}
                        </span>
                      )}
                    </div>
                    <div className="day-badges">
                      {slot?.tags?.slice(0, 2).map((t) => (
                        <span
                          key={t.id}
                          className="badge tag-badge"
                          style={{
                            background: t.color || DEFAULT_TAG_COLOR,
                            color: readableTextColor(t.color || DEFAULT_TAG_COLOR),
                          }}
                        >
                          {t.name}
                        </span>
                      ))}
                      {slot?.makes_lunch && <span className="badge badge-lunch">Lunch</span>}
                      {slot && slot.inventory_score?.score !== undefined && (
                        <span className={`badge ${scoreClass(slot.inventory_score?.score)}`}>
                          {scoreLabel(slot.inventory_score?.score)}
                        </span>
                      )}
                    </div>
                  </div>
                </DraggableCard>
              </DroppableCard>
            );
          })}
          <div className="week-grid-spacer" />
        </div>

        <DragOverlay>
          {activeId && slotByDate(activeId) && (
            <div
              className="day-card"
              style={{ opacity: 0.9, boxShadow: "0 4px 16px rgba(0,0,0,.2)" }}
            >
              <div className="day-card-body">
                <span className="meal-name">{slotByDate(activeId)!.recipe_name}</span>
              </div>
            </div>
          )}
        </DragOverlay>
      </DndContext>
      )}

      {dayActionDate && slotByDate(dayActionDate) && (
        <DayActionModal
          date={dayActionDate}
          slot={slotByDate(dayActionDate)!}
          onClose={() => setDayActionDate(null)}
          onChoose={(mode) => {
            setDayActionDate(null);
            if (mode === "reset") {
              handleClear(dayActionDate);
              return;
            }
            setWizard({ date: dayActionDate, mode });
          }}
        />
      )}

      {wizard && (
        <MealWizard
          date={wizard.date}
          slot={slotByDate(wizard.date)}
          mode={wizard.mode}
          canEdit={canEdit}
          onComplete={(recipe, sides) => handleWizardComplete(wizard.date, recipe, sides)}
          onClose={() => setWizard(null)}
        />
      )}

      {showDatePicker && (
        <DatePickerModal
          initialDate={viewMode === "week" ? monday : new Date(monthCursor.year, monthCursor.month - 1, 1)}
          onSelect={jumpToDate}
          onClose={() => setShowDatePicker(false)}
        />
      )}
    </div>
  );
}

// ─── MonthGrid / DatePickerModal ───────────────────────────────────────────────

function MonthGrid({
  year,
  month,
  slots,
  onSelectDay,
}: {
  year: number;
  month: number;
  slots: MealSlot[];
  onSelectDay: (iso: string) => void;
}) {
  const slotsByDate = new Map(slots.map((s) => [s.slot_date, s]));
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month, 0).getDate();
  const todayIso = toIso(new Date());

  return (
    <div className="month-panel">
      <div className="weekday-row">
        {DAYS_FR.map((d) => <div key={d}>{d}</div>)}
      </div>
      <div className="days-grid">
        {Array.from({ length: firstWeekday }, (_, i) => (
          <div key={`blank-${i}`} className="day-cell blank" />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
          const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const slot = slotsByDate.get(iso);
          return (
            <button
              key={iso}
              type="button"
              className={`day-cell${slot ? " has-meal" : ""}${iso === todayIso ? " today" : ""}`}
              onClick={() => onSelectDay(iso)}
            >
              <span className="day-number">{day}</span>
              {slot && <span className="event-label">{slot.recipe_name}</span>}
              {slot?.makes_lunch && <span className="month-lunch-dot" aria-hidden="true" title="Fait des lunchs" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DatePickerModal({
  initialDate,
  onSelect,
  onClose,
}: {
  initialDate: Date;
  onSelect: (iso: string) => void;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState({
    year: initialDate.getFullYear(),
    month: initialDate.getMonth() + 1,
  });
  const [slots, setSlots] = useState<MealSlot[]>([]);

  useEffect(() => {
    api<{ slots: MealSlot[] }>(`/api/month/${cursor.year}/${cursor.month}`)
      .then((d) => setSlots(d.slots))
      .catch(() => setSlots([]));
  }, [cursor]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <button className="btn-icon" onClick={() => setCursor((c) => shiftMonth(c, -1))}>
            <ChevronLeft size={16} />
          </button>
          <span className="modal-title" style={{ flex: 1, textAlign: "center" }}>
            {MONTHS_FR[cursor.month - 1]} {cursor.year}
          </span>
          <button className="btn-icon" onClick={() => setCursor((c) => shiftMonth(c, 1))}>
            <ChevronRight size={16} />
          </button>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <MonthGrid year={cursor.year} month={cursor.month} slots={slots} onSelectDay={onSelect} />
      </div>
    </div>
  );
}

// ─── StepIndicator ("station de métro") ────────────────────────────────────────

function StepIndicator({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="step-indicator">
      {steps.map((label, i) => (
        <div key={label} className={`step${i === current ? " active" : ""}${i < current ? " done" : ""}`}>
          <span className="step-dot">{i < current ? <CheckCircle size={12} /> : i + 1}</span>
          <span className="step-label">{label}</span>
          {i < steps.length - 1 && <span className="step-line" />}
        </div>
      ))}
    </div>
  );
}

// ─── SidesEditor (état local, rien n'est persisté avant la confirmation) ───────

function SidesEditor({ sides, onChange }: { sides: SlotSide[]; onChange: (s: SlotSide[]) => void }) {
  const [input, setInput] = useState("");
  const [open, setOpen] = useState(false);
  const [libSides, setLibSides] = useState<Side[]>([]);
  const [favorites, setFavorites] = useState<FavoriteSide[]>([]);

  useEffect(() => {
    api<Side[]>("/api/sides").then(setLibSides).catch(() => {});
    api<FavoriteSide[]>("/api/sides/favorites").then(setFavorites).catch(() => {});
  }, []);

  const suggestions = input.length > 0
    ? libSides.filter((s) => s.name.toLowerCase().includes(input.toLowerCase()))
    : libSides.slice(0, 8);
  const exactMatch = suggestions.some((s) => s.name.toLowerCase() === input.trim().toLowerCase());
  const chosenNames = new Set(sides.map((s) => s.name.toLowerCase()));

  function addSide(name: string, sideId?: string) {
    onChange([...sides, {
      id: `tmp-${Date.now()}`,
      side_id: sideId,
      name,
      free_text: sideId ? "" : name,
      category: libSides.find((s) => s.id === sideId)?.category ?? "",
      sort_order: sides.length,
    }]);
    setInput("");
    setOpen(false);
  }

  function removeSide(sideId: string) {
    onChange(sides.filter((s) => s.id !== sideId));
  }

  return (
    <div>
      <div className="sides-list">
        {sides.map((s) => (
          <span key={s.id} className="side-chip">
            {s.name}
            <button onClick={() => removeSide(s.id)} title="Retirer">
              <X size={11} />
            </button>
          </span>
        ))}
        {sides.length === 0 && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Aucun accompagnement</span>
        )}
      </div>

      <div className="combo">
        <div className="combo-input-row">
          <Search size={14} style={{ color: "var(--muted)", flexShrink: 0 }} />
          <input
            value={input}
            onChange={(e) => { setInput(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="Rechercher ou ajouter un accompagnement…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && input.trim()) addSide(input.trim());
            }}
          />
        </div>
        {open && (
          <div className="combo-dropdown">
            {suggestions.map((s) => (
              <button key={s.id} className="combo-option" onMouseDown={() => addSide(s.name, s.id)}>
                {s.name}
              </button>
            ))}
            {input.trim() && !exactMatch && (
              <button className="combo-option combo-option-new" onMouseDown={() => addSide(input.trim())}>
                Ajouter « {input.trim()} »
              </button>
            )}
            {suggestions.length === 0 && !input.trim() && (
              <div className="combo-empty">Aucun accompagnement dans la bibliothèque</div>
            )}
          </div>
        )}
      </div>

      {!open && !input && favorites.length > 0 && (
        <div className="favorites-row">
          <div className="favorites-label">Fréquents</div>
          <div className="filter-chips">
            {favorites
              .filter((f) => !chosenNames.has(f.name.toLowerCase()))
              .map((f) => (
                <button key={f.name} className="filter-chip" onClick={() => addSide(f.name, f.side_id)}>
                  {f.name}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── DayActionModal (jour déjà renseigné : que veut-on modifier ?) ────────────

function DayActionModal({
  date,
  slot,
  onClose,
  onChoose,
}: {
  date: string;
  slot: MealSlot;
  onClose: () => void;
  onChoose: (mode: "meal" | "sides" | "both" | "reset") => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <span className="modal-title" style={{ flex: 1 }}>{fmtDateFull(date)}</span>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{slot.recipe_name}</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
            {slot.sides.length > 0 ? slot.sides.map((s) => s.name).join(", ") : "Aucun accompagnement"}
          </div>
        </div>
        <div className="day-action-list">
          <button className="btn btn-secondary day-action-btn" onClick={() => onChoose("meal")}>
            Modifier le repas
          </button>
          <button className="btn btn-secondary day-action-btn" onClick={() => onChoose("sides")}>
            Modifier l'accompagnement
          </button>
          <button className="btn btn-secondary day-action-btn" onClick={() => onChoose("both")}>
            Modifier le repas et l'accompagnement
          </button>
          <button className="btn btn-danger day-action-btn" onClick={() => onChoose("reset")}>
            Remettre à zéro
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── MealWizard (modal, choix du repas puis de l'accompagnement) ──────────────

type WizardMode = "new" | "meal" | "sides" | "both";

function MealWizard({
  date,
  slot,
  mode,
  canEdit,
  onComplete,
  onClose,
}: {
  date: string;
  slot?: MealSlot;
  mode: WizardMode;
  canEdit: boolean;
  onComplete: (recipe: Recipe | null, sides: SlotSide[] | null) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"meal" | "sides" | "confirm">(mode === "sides" ? "sides" : "meal");
  const [chosenRecipe, setChosenRecipe] = useState<Recipe | null>(null);
  const [chosenSides, setChosenSides] = useState<SlotSide[]>(
    mode === "meal" || mode === "sides" ? (slot?.sides ?? []) : []
  );
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [favorites, setFavorites] = useState<Recipe[]>([]);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const filterTags = useFilterableTags();

  useEffect(() => {
    if (mode === "sides") return;
    setLoading(true);
    api<Recipe[]>("/api/recipes")
      .then(setRecipes)
      .finally(() => setLoading(false));
    api<Recipe[]>("/api/recipes/favorites").then(setFavorites).catch(() => {});
  }, [mode]);

  function toggleFilter(f: string) {
    setFilters((prev) => {
      const n = new Set(prev);
      n.has(f) ? n.delete(f) : n.add(f);
      return n;
    });
  }

  const filtered = recipes.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filters.has("rapide") && (!r.prep_minutes || r.prep_minutes > 30)) return false;
    if (filters.has("dispo") && (r.inventory_score?.score ?? 0) < 0.8) return false;
    for (const t of filterTags) {
      if (filters.has(t.id) && !hasTag(r, t.id)) return false;
    }
    return true;
  });

  const isIdle = !q && filters.size === 0;
  const showingFavorites = isIdle && favorites.length > 0;
  const mealList = showingFavorites ? favorites : isIdle ? recipes : filtered;

  function pickMeal(r: Recipe) {
    setChosenRecipe(r);
    if (mode === "meal") {
      // Le repas seul change : on garde l'accompagnement existant, étape sides sautée.
      setStep("confirm");
    } else {
      setChosenSides([]);
      setStep("sides");
    }
  }

  function handleConfirm() {
    const recipeToSave = mode === "sides" ? null : chosenRecipe;
    const sidesToSave = mode === "meal" ? null : chosenSides;
    onComplete(recipeToSave, sidesToSave);
  }

  const steps = mode === "meal" ? ["Repas", "Confirmer"]
    : mode === "sides" ? ["Accompagnement", "Confirmer"]
    : ["Repas", "Accompagnement", "Confirmer"];
  const currentIndex = step === "confirm" ? steps.length - 1
    : step === "sides" ? (mode === "sides" ? 0 : 1)
    : 0;

  const confirmRecipeName = mode === "sides" ? slot?.recipe_name : chosenRecipe?.name;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <span className="modal-title" style={{ flex: 1 }}>
            {mode === "sides" ? "Choisir l'accompagnement" : "Choisir un repas"} — {fmtDateFull(date)}
          </span>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <StepIndicator steps={steps} current={currentIndex} />

        {step === "meal" && (
          <>
            <div className="search-bar">
              <Search size={16} style={{ alignSelf: "center", color: "var(--muted)" }} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Rechercher une recette…"
              />
            </div>
            <div className="filter-chips">
              {["dispo", "rapide"].map((f) => (
                <button
                  key={f}
                  className={`filter-chip${filters.has(f) ? " active" : ""}`}
                  onClick={() => toggleFilter(f)}
                >
                  {f === "dispo" ? "Disponible" : "< 30 min"}
                </button>
              ))}
              {filterTags.map((t) => (
                <button
                  key={t.id}
                  className={`filter-chip${filters.has(t.id) ? " active" : ""}`}
                  onClick={() => toggleFilter(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
            {loading ? (
              <div className="empty-state"><RefreshCw size={24} className="spin" /></div>
            ) : (
              <div className="recipe-list">
                {showingFavorites && <div className="favorites-label">Favoris</div>}
                {mealList.length === 0 && (
                  <div className="empty-state"><p>Aucune recette trouvée</p></div>
                )}
                {mealList.map((r) => {
                  const key = r.source === "mealie" ? `mealie-${r.slug}` : `local-${r.id}`;
                  return (
                    <div key={key} className="recipe-card" onClick={() => pickMeal(r)}>
                      <div className="recipe-card-header">
                        <span className="recipe-card-name">{r.name}</span>
                      </div>
                      <div className="recipe-card-meta">
                        {r.makes_lunch && <span className="badge badge-lunch">Lunch</span>}
                        {r.is_weekend && <span className="badge badge-weekend">Weekend</span>}
                        {r.prep_minutes && (
                          <span className="recipe-last">{r.prep_minutes} min</span>
                        )}
                        {r.inventory_score?.score !== null && r.inventory_score?.score !== undefined && (
                          <span className={`badge ${scoreClass(r.inventory_score.score)}`}>
                            {Math.round(r.inventory_score.score * 100)}%
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {step === "sides" && (
          <>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>
              {mode === "sides" ? slot?.recipe_name : chosenRecipe?.name}
            </div>
            <SidesEditor sides={chosenSides} onChange={setChosenSides} />
            <div className="form-actions">
              <button
                className="btn btn-secondary"
                onClick={() => { setChosenSides([]); setStep("confirm"); }}
              >
                Aucun accompagnement
              </button>
              <button className="btn btn-primary" onClick={() => setStep("confirm")}>
                Continuer
              </button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{confirmRecipeName}</div>
              <div className="sides-list" style={{ marginTop: 6 }}>
                {chosenSides.length === 0 ? (
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>Aucun accompagnement</span>
                ) : (
                  chosenSides.map((s) => (
                    <span key={s.id} className="side-chip">{s.name}</span>
                  ))
                )}
              </div>
            </div>
            <div className="form-actions" style={{ justifyContent: "space-between" }}>
              <button className="btn btn-danger btn-sm" onClick={onClose}>Annuler</button>
              <button className="btn btn-primary" onClick={handleConfirm} disabled={!canEdit}>
                Confirmer
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── RecipesScreen ────────────────────────────────────────────────────────────

function RecipesScreen({ canEdit }: { canEdit: boolean }) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Recipe | null>(null);
  const [showAddLocal, setShowAddLocal] = useState(false);
  const filterTags = useFilterableTags();

  useEffect(() => {
    api<Recipe[]>("/api/recipes?include_hidden=true")
      .then(setRecipes)
      .finally(() => setLoading(false));
  }, []);

  function toggleFilter(f: string) {
    setFilters((prev) => {
      const n = new Set(prev);
      n.has(f) ? n.delete(f) : n.add(f);
      return n;
    });
  }

  const showHidden = filters.has("masquees");
  const filtered = recipes.filter((r) => {
    if (r.is_hidden !== showHidden) return false;
    if (q && !r.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filters.has("rapide") && (!r.prep_minutes || r.prep_minutes > 30)) return false;
    if (filters.has("dispo") && (r.inventory_score?.score ?? 0) < 0.8) return false;
    for (const t of filterTags) {
      if (filters.has(t.id) && !hasTag(r, t.id)) return false;
    }
    return true;
  });

  return (
    <div className="screen-pad">
      <div className="search-bar">
        <Search size={16} style={{ alignSelf: "center", color: "var(--muted)" }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher une recette…"
        />
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setShowAddLocal(true)}>
            <Plus size={15} /> Nouvelle
          </button>
        )}
      </div>
      <div className="filter-chips">
        {["dispo", "rapide", "masquees"].map((f) => (
          <button
            key={f}
            className={`filter-chip${filters.has(f) ? " active" : ""}`}
            onClick={() => toggleFilter(f)}
          >
            {f === "dispo" ? "Disponible" : f === "rapide" ? "< 30 min" : "Masquées"}
          </button>
        ))}
        {filterTags.map((t) => (
          <button
            key={t.id}
            className={`filter-chip${filters.has(t.id) ? " active" : ""}`}
            onClick={() => toggleFilter(t.id)}
          >
            {t.name}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="empty-state"><RefreshCw size={24} /></div>
      ) : (
        <div className="recipe-list">
          {filtered.length === 0 && (
            <div className="empty-state"><p>Aucune recette trouvée</p></div>
          )}
          {filtered.map((r) => {
            const key = r.source === "mealie" ? `mealie-${r.slug}` : `local-${r.id}`;
            return (
              <div key={key} className="recipe-card" onClick={() => setDetail(r)}>
                <div className="recipe-card-header">
                  <span className="recipe-card-name">{r.name}</span>
                  <span className={`source-badge ${r.source}`}>
                    {r.source === "mealie" ? "Mealie" : "Local"}
                  </span>
                </div>
                <div className="recipe-card-meta">
                  {r.makes_lunch && <span className="badge badge-lunch">Lunch</span>}
                  {r.is_weekend && <span className="badge badge-weekend">Weekend</span>}
                  {r.prep_minutes && (
                    <span className="recipe-last">{r.prep_minutes} min</span>
                  )}
                  {r.inventory_score?.score !== null && r.inventory_score?.score !== undefined && (
                    <span className={`badge ${scoreClass(r.inventory_score.score)}`}>
                      {Math.round(r.inventory_score.score * 100)}% dispo
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {detail && (
        <RecipeDetailModal
          recipe={detail}
          canEdit={canEdit}
          onClose={() => setDetail(null)}
          onUpdated={(updated) => {
            setRecipes((prev) =>
              prev.map((r) =>
                (r.source === updated.source &&
                  ((r.slug && r.slug === updated.slug) ||
                    (r.id && r.id === updated.id)))
                  ? updated
                  : r
              )
            );
            setDetail(updated);
          }}
          onDeleted={() => {
            setRecipes((prev) =>
              prev.filter((r) => !(r.source === "local" && r.id === detail.id))
            );
            setDetail(null);
          }}
        />
      )}
      {showAddLocal && (
        <LocalRecipeModal
          onClose={() => setShowAddLocal(false)}
          onSaved={(r) => {
            setRecipes((prev) => [...prev, r]);
            setShowAddLocal(false);
          }}
        />
      )}
    </div>
  );
}

// ─── RecipeDetailModal ────────────────────────────────────────────────────────

function RecipeDetailModal({
  recipe,
  canEdit,
  onClose,
  onUpdated,
  onDeleted,
}: {
  recipe: Recipe;
  canEdit: boolean;
  onClose: () => void;
  onUpdated: (r: Recipe) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(recipe.name);
  const [prep, setPrep] = useState(recipe.prep_minutes?.toString() ?? "");
  const [isWeekend, setIsWeekend] = useState(recipe.is_weekend);
  const [makesLunch, setMakesLunch] = useState(recipe.makes_lunch);
  const [isHidden, setIsHidden] = useState(recipe.is_hidden);
  const [tagIds, setTagIds] = useState<string[]>(recipe.tag_ids ?? []);
  const [allTags, setAllTags] = useState<CanonicalTag[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (recipe.source !== "local") return;
    api<CanonicalTag[]>("/api/tags")
      .then((t) => setAllTags([...t].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, [recipe.source]);

  async function save() {
    setSaving(true);
    try {
      if (recipe.source === "mealie" && recipe.slug) {
        await api(`/api/recipes/mealie/${recipe.slug}/meta`, {
          method: "PATCH",
          body: JSON.stringify({ is_weekend: isWeekend, makes_lunch: makesLunch, is_hidden: isHidden }),
        });
        onUpdated({ ...recipe, is_weekend: isWeekend, makes_lunch: makesLunch, is_hidden: isHidden });
      } else if (recipe.source === "local" && recipe.id) {
        const updated = await api<Recipe>(`/api/local-recipes/${recipe.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(),
            prep_minutes: prep ? parseInt(prep) : null,
            is_weekend: isWeekend,
            makes_lunch: makesLunch,
            tag_ids: tagIds,
          }),
        });
        onUpdated({ ...recipe, ...updated, source: "local" });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!recipe.id) return;
    if (!confirm(`Supprimer "${recipe.name}" ?`)) return;
    await api(`/api/local-recipes/${recipe.id}`, { method: "DELETE" });
    onDeleted();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <span className="modal-title" style={{ flex: 1 }}>{recipe.source === "local" ? name : recipe.name}</span>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <div style={{ marginBottom: 12 }}>
          <span className={`source-badge ${recipe.source}`}>
            {recipe.source === "mealie" ? "Mealie" : "Recette locale"}
          </span>
          {recipe.prep_minutes && (
            <span className="recipe-last" style={{ marginLeft: 8 }}>{recipe.prep_minutes} min</span>
          )}
        </div>
        {recipe.inventory_score?.score !== null && recipe.inventory_score?.score !== undefined && (
          <div style={{ marginBottom: 12 }}>
            <span className={`badge ${scoreClass(recipe.inventory_score.score)}`}>
              {Math.round(recipe.inventory_score.score * 100)}% des ingrédients disponibles
            </span>
            {recipe.inventory_score.missing.length > 0 && (
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                Manquants : {recipe.inventory_score.missing.join(", ")}
              </div>
            )}
          </div>
        )}
        {recipe.source === "mealie" && recipe.tags.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 4 }}>
              Tags canoniques (via Paramètres → Tags Mealie → Tags canoniques)
            </label>
            <div className="day-badges" style={{ flexWrap: "wrap" }}>
              {recipe.tags.map((t) => (
                <span
                  key={t.id}
                  className="badge tag-badge"
                  style={{ background: t.color || DEFAULT_TAG_COLOR, color: readableTextColor(t.color || DEFAULT_TAG_COLOR) }}
                >
                  {t.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {canEdit && (
          <>
            {recipe.source === "local" && (
              <div className="form-row">
                <label>Nom</label>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
            )}
            {recipe.source === "local" && (
              <div className="form-row">
                <label>Temps de préparation (min)</label>
                <input type="number" value={prep} onChange={(e) => setPrep(e.target.value)} min="0" />
              </div>
            )}
            <div className="form-row">
              <label>
                <input
                  type="checkbox"
                  checked={isWeekend}
                  onChange={(e) => setIsWeekend(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Repas week-end
              </label>
            </div>
            <div className="form-row">
              <label>
                <input
                  type="checkbox"
                  checked={makesLunch}
                  onChange={(e) => setMakesLunch(e.target.checked)}
                  style={{ marginRight: 6 }}
                />
                Fait des lunchs le lendemain
              </label>
            </div>
            {recipe.source === "local" && (
              <div className="form-row">
                <label>Tags</label>
                <select
                  multiple
                  value={tagIds}
                  onChange={(e) => setTagIds(Array.from(e.target.selectedOptions, (o) => o.value))}
                  size={Math.min(6, Math.max(3, allTags.length || 1))}
                >
                  {allTags.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
            )}
            {recipe.source === "mealie" && (
              <div className="form-row">
                <label>
                  <input
                    type="checkbox"
                    checked={isHidden}
                    onChange={(e) => setIsHidden(e.target.checked)}
                    style={{ marginRight: 6 }}
                  />
                  Masquer cette recette (n'apparaît plus dans l'onglet Recettes ni le choix de repas)
                </label>
              </div>
            )}
            <div className="form-actions">
              {recipe.source === "local" && (
                <button className="btn btn-danger" onClick={handleDelete}>
                  <Trash2 size={14} /> Supprimer
                </button>
              )}
              <button className="btn btn-secondary" onClick={onClose}>Annuler</button>
              <button
                className="btn btn-primary"
                onClick={save}
                disabled={saving || (recipe.source === "local" && !name.trim())}
              >
                {saving ? "…" : "Enregistrer"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── LocalRecipeModal ─────────────────────────────────────────────────────────

function LocalRecipeModal({
  recipe,
  onClose,
  onSaved,
}: {
  recipe?: Recipe;
  onClose: () => void;
  onSaved: (r: Recipe) => void;
}) {
  const [name, setName] = useState(recipe?.name ?? "");
  const [isWeekend, setIsWeekend] = useState(recipe?.is_weekend ?? false);
  const [makesLunch, setMakesLunch] = useState(recipe?.makes_lunch ?? false);
  const [prep, setPrep] = useState(recipe?.prep_minutes?.toString() ?? "");
  const [notes, setNotes] = useState(recipe?.notes ?? "");
  const [tagIds, setTagIds] = useState<string[]>(recipe?.tag_ids ?? []);
  const [allTags, setAllTags] = useState<CanonicalTag[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<CanonicalTag[]>("/api/tags")
      .then((t) => setAllTags([...t].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        is_weekend: isWeekend,
        makes_lunch: makesLunch,
        prep_minutes: prep ? parseInt(prep) : null,
        notes,
        tag_ids: tagIds,
      };
      let r: Recipe;
      if (recipe?.id) {
        r = await api<Recipe>(`/api/local-recipes/${recipe.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        r = await api<Recipe>("/api/local-recipes", {
          method: "POST",
          body: JSON.stringify(body),
        });
      }
      onSaved({ ...r, source: "local", is_hidden: false });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <span className="modal-title" style={{ flex: 1 }}>
            {recipe ? "Modifier la recette" : "Nouvelle recette locale"}
          </span>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="form-row">
          <label>Nom</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="form-row">
          <label>Temps de préparation (min)</label>
          <input type="number" value={prep} onChange={(e) => setPrep(e.target.value)} min="0" />
        </div>
        <div className="form-row">
          <label>
            <input type="checkbox" checked={isWeekend} onChange={(e) => setIsWeekend(e.target.checked)} style={{ marginRight: 6 }} />
            Repas week-end
          </label>
        </div>
        <div className="form-row">
          <label>
            <input type="checkbox" checked={makesLunch} onChange={(e) => setMakesLunch(e.target.checked)} style={{ marginRight: 6 }} />
            Fait des lunchs le lendemain
          </label>
        </div>
        <div className="form-row">
          <label>Tags</label>
          <select
            multiple
            value={tagIds}
            onChange={(e) => setTagIds(Array.from(e.target.selectedOptions, (o) => o.value))}
            size={Math.min(6, Math.max(3, allTags.length || 1))}
          >
            {allTags.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </div>
        <div className="form-actions">
          <button className="btn btn-secondary" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim()}>
            {saving ? "…" : "Enregistrer"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── StatsScreen ──────────────────────────────────────────────────────────────

function StatsScreen() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<HistoryResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [freq, setFreq] = useState<FreqEntry[]>([]);
  const [freqWeeks, setFreqWeeks] = useState(12);

  useEffect(() => {
    api<FreqEntry[]>(`/api/stats/frequency?weeks=${freqWeeks}`)
      .then(setFreq)
      .catch(() => {});
  }, [freqWeeks]);

  async function search() {
    if (!q.trim()) return;
    setSearching(true);
    try {
      const r = await api<HistoryResult[]>(`/api/stats/history?q=${encodeURIComponent(q)}`);
      setResults(r);
    } finally {
      setSearching(false);
    }
  }

  const maxCount = Math.max(...freq.map((f) => f.count), 1);

  return (
    <div className="screen-pad">
      <div className="settings-section">
        <h2>Rechercher dans l'historique</h2>
        <div className="search-bar stats-search">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ex. chili, poulet, saumon…"
            onKeyDown={(e) => e.key === "Enter" && search()}
          />
          <button className="btn btn-primary" onClick={search}>
            <Search size={15} />
          </button>
        </div>
        {results.length > 0 && (
          <div>
            {results.map((r) => (
              <div key={r.id} className="history-result">
                <div className="hr-name">{r.recipe_name}</div>
                <div className="hr-date">{fmtDateFull(r.slot_date)}</div>
              </div>
            ))}
          </div>
        )}
        {q && results.length === 0 && !searching && (
          <div className="empty-state"><p>Aucun résultat pour « {q} »</p></div>
        )}
      </div>

      <div className="settings-section">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Fréquence des repas</h2>
          <div className="filter-chips" style={{ margin: 0 }}>
            {[4, 8, 12].map((w) => (
              <button
                key={w}
                className={`filter-chip${freqWeeks === w ? " active" : ""}`}
                onClick={() => setFreqWeeks(w)}
              >
                {w} sem.
              </button>
            ))}
          </div>
        </div>
        {freq.length === 0 ? (
          <div className="empty-state"><p>Pas encore de données</p></div>
        ) : (
          <table className="freq-table">
            <thead>
              <tr>
                <th>Repas</th>
                <th>Fréquence</th>
                <th>Dernière fois</th>
              </tr>
            </thead>
            <tbody>
              {freq.map((f) => (
                <tr key={f.recipe_name}>
                  <td>{f.recipe_name}</td>
                  <td style={{ width: 120 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div
                        className="freq-bar"
                        style={{ width: `${(f.count / maxCount) * 80}px` }}
                      />
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>{f.count}×</span>
                    </div>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--muted)" }}>
                    {weeksAgo(f.last_date)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── SettingsScreen ───────────────────────────────────────────────────────────

function SettingsScreen({ canAdmin, canEdit }: { canAdmin: boolean; canEdit: boolean }) {
  return (
    <div className="screen-pad">
      {canAdmin && <TagMappingsSection />}
      {canAdmin && <CanonicalTagsSection />}
      {canEdit && <SidesLibrarySection />}
      <NotificationsSection />
    </div>
  );
}

function TagMappingsSection() {
  const [mappings, setMappings] = useState<TagMapping[]>([]);
  const [tags, setTags] = useState<CanonicalTag[]>([]);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    api<TagMapping[]>("/api/tag-mappings").then(setMappings).catch(() => {});
    api<CanonicalTag[]>("/api/tags").then(setTags).catch(() => {});
  }, []);

  async function confirm(mapping: TagMapping, canonicalId: string | undefined, status: string) {
    const updated = await api<TagMapping>(`/api/tag-mappings/${encodeURIComponent(mapping.mealie_tag_name)}`, {
      method: "PUT",
      body: JSON.stringify({ canonical_tag_id: canonicalId, status }),
    });
    setMappings((prev) => prev.map((m) => (m.mealie_tag_name === mapping.mealie_tag_name ? updated : m)));
  }

  async function syncTags() {
    setSyncing(true);
    try {
      await api("/api/tag-mappings/sync", { method: "POST" });
      const updated = await api<TagMapping[]>("/api/tag-mappings");
      setMappings(updated);
    } finally {
      setSyncing(false);
    }
  }

  const pending = mappings.filter((m) => m.status === "pending");
  const rest = mappings.filter((m) => m.status !== "pending");

  return (
    <div className="settings-section">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <h2 style={{ flex: 1, margin: 0 }}>Tags Mealie → Tags canoniques</h2>
        <button className="btn btn-secondary" onClick={syncTags} disabled={syncing}>
          <RefreshCw size={13} /> {syncing ? "…" : "Sync"}
        </button>
      </div>
      {pending.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: "var(--amber)", fontWeight: 600, marginBottom: 6 }}>
            {pending.length} tag(s) en attente de confirmation
          </div>
          {pending.map((m) => (
            <div key={m.mealie_tag_name} className="tag-mapping-row">
              <span className="status-dot pending" />
              <span className="mealie-tag">{m.mealie_tag_name}</span>
              <select
                style={{ fontSize: 12, padding: "3px 6px", border: "1px solid var(--line)", borderRadius: 4 }}
                defaultValue={m.canonical_tag_id ?? ""}
                onChange={(e) => confirm(m, e.target.value || undefined, "confirmed")}
              >
                <option value="">— Ignorer —</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button
                className="btn btn-ghost"
                style={{ fontSize: 11 }}
                onClick={() => confirm(m, undefined, "ignored")}
              >
                Ignorer
              </button>
            </div>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div>
          {rest.map((m) => (
            <div key={m.mealie_tag_name} className="tag-mapping-row">
              <span className={`status-dot ${m.status}`} />
              <span className="mealie-tag">{m.mealie_tag_name}</span>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {m.canonical_tag_name ?? "—"}
              </span>
            </div>
          ))}
        </div>
      )}
      {mappings.length === 0 && (
        <div className="empty-state"><p>Aucun tag Mealie importé</p></div>
      )}
    </div>
  );
}

function CanonicalTagsSection() {
  const [tags, setTags] = useState<CanonicalTag[]>([]);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    api<CanonicalTag[]>("/api/tags")
      .then((t) => setTags([...t].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => {});
  }, []);

  async function addTag() {
    if (!newName.trim()) return;
    const t = await api<CanonicalTag>("/api/tags", {
      method: "POST",
      body: JSON.stringify({ name: newName.trim() }),
    });
    setTags((prev) => [...prev, t].sort((a, b) => a.name.localeCompare(b.name)));
    setNewName("");
  }

  async function renameTag(id: string, name: string) {
    if (!name.trim()) return;
    const t = await api<CanonicalTag>(`/api/tags/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim() }),
    });
    setTags((prev) => prev.map((x) => (x.id === id ? t : x)).sort((a, b) => a.name.localeCompare(b.name)));
  }

  async function recolorTag(id: string, color: string) {
    const t = await api<CanonicalTag>(`/api/tags/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ color }),
    });
    setTags((prev) => prev.map((x) => (x.id === id ? t : x)));
  }

  async function toggleTagFilter(id: string, isFilter: boolean) {
    const t = await api<CanonicalTag>(`/api/tags/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_filter: isFilter }),
    });
    setTags((prev) => prev.map((x) => (x.id === id ? t : x)));
  }

  async function deleteTag(id: string) {
    await api(`/api/tags/${id}`, { method: "DELETE" });
    setTags((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <div className="settings-section">
      <h2>Tags canoniques</h2>
      <div className="canonical-tags-list" style={{ marginBottom: 8 }}>
        {tags.map((t) => (
          <div key={t.id} className="canonical-tag-row">
            <input
              type="color"
              value={t.color || DEFAULT_TAG_COLOR}
              onChange={(e) => recolorTag(t.id, e.target.value)}
              title="Couleur du badge dans l'onglet Semaine"
              className="tag-color-input"
            />
            <input
              defaultValue={t.name}
              key={t.id + t.name}
              onBlur={(e) => e.target.value !== t.name && renameTag(t.id, e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="tag-name-input"
            />
            <button
              className={`btn-icon${t.is_filter ? " tag-filter-active" : ""}`}
              onClick={() => toggleTagFilter(t.id, !t.is_filter)}
              title={t.is_filter ? "Filtre actif dans l'onglet Repas (cliquer pour désactiver)" : "Afficher comme filtre dans l'onglet Repas"}
            >
              <Filter size={13} />
            </button>
            <button className="btn-icon" onClick={() => deleteTag(t.id)} title="Supprimer">
              <X size={13} />
            </button>
          </div>
        ))}
        {tags.length === 0 && (
          <div className="empty-state"><p>Aucun tag canonique</p></div>
        )}
      </div>
      <div className="sides-add">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nouveau tag…"
          onKeyDown={(e) => e.key === "Enter" && addTag()}
        />
        <button onClick={addTag}><Plus size={14} /></button>
      </div>
    </div>
  );
}

function SidesLibrarySection() {
  const [sides, setSides] = useState<Side[]>([]);
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState("");
  const [editing, setEditing] = useState<Side | null>(null);

  useEffect(() => {
    api<Side[]>("/api/sides").then(setSides).catch(() => {});
  }, []);

  async function addSide() {
    if (!newName.trim()) return;
    const s = await api<Side>("/api/sides", {
      method: "POST",
      body: JSON.stringify({ name: newName.trim(), category: newCat.trim() }),
    });
    setSides((prev) => [...prev, s]);
    setNewName("");
    setNewCat("");
  }

  async function deleteSide(id: string) {
    await api(`/api/sides/${id}`, { method: "DELETE" });
    setSides((prev) => prev.filter((s) => s.id !== id));
  }

  const categories = [...new Set(sides.map((s) => s.category).filter(Boolean))];

  return (
    <div className="settings-section">
      <h2>Bibliothèque d'accompagnements</h2>
      {categories.length > 0 ? (
        categories.map((cat) => (
          <div key={cat} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>
              {cat}
            </div>
            <div className="sides-list">
              {sides.filter((s) => s.category === cat).map((s) => (
                <span key={s.id} className="side-chip">
                  {s.name}
                  <button onClick={() => deleteSide(s.id)} title="Supprimer"><X size={11} /></button>
                </span>
              ))}
            </div>
          </div>
        ))
      ) : null}
      {sides.filter((s) => !s.category).length > 0 && (
        <div className="sides-list" style={{ marginBottom: 8 }}>
          {sides.filter((s) => !s.category).map((s) => (
            <span key={s.id} className="side-chip">
              {s.name}
              <button onClick={() => deleteSide(s.id)} title="Supprimer"><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Accompagnement…"
          style={{ flex: 2, border: "1px solid var(--line)", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}
          onKeyDown={(e) => e.key === "Enter" && addSide()}
        />
        <input
          value={newCat}
          onChange={(e) => setNewCat(e.target.value)}
          placeholder="Catégorie (optionnel)"
          style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 6, padding: "6px 10px", fontSize: 13 }}
        />
        <button className="btn btn-primary" onClick={addSide}><Plus size={14} /></button>
      </div>
    </div>
  );
}

function NotificationsSection() {
  const [enabled, setEnabled] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [vapidKey, setVapidKey] = useState("");

  useEffect(() => {
    api<{ vapid_public_key: string; enabled: boolean }>("/api/notifications/config")
      .then((c) => {
        setEnabled(c.enabled);
        setVapidKey(c.vapid_public_key);
        if ("serviceWorker" in navigator && "PushManager" in window) {
          navigator.serviceWorker.ready.then((reg) => {
            reg.pushManager.getSubscription().then((sub) => {
              setSubscribed(!!sub);
              setLoading(false);
            });
          }).catch(() => setLoading(false));
        } else {
          setLoading(false);
        }
      })
      .catch(() => setLoading(false));
  }, []);

  async function subscribe() {
    if (!vapidKey) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
    });
    await api("/api/notifications/subscriptions", {
      method: "POST",
      body: JSON.stringify(sub.toJSON()),
    });
    setSubscribed(true);
  }

  async function unsubscribe() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api("/api/notifications/subscriptions", {
        method: "DELETE",
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
    setSubscribed(false);
  }

  if (!enabled) {
    return (
      <div className="settings-section">
        <h2>Notifications</h2>
        <p style={{ fontSize: 13, color: "var(--muted)" }}>
          Les notifications push ne sont pas configurées sur ce serveur.
        </p>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2>Notifications</h2>
      {loading ? (
        <p style={{ fontSize: 13, color: "var(--muted)" }}>Chargement…</p>
      ) : subscribed ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Bell size={18} color="var(--green)" />
          <span style={{ fontSize: 13, flex: 1 }}>Notifications activées sur cet appareil</span>
          <button className="btn btn-secondary" onClick={unsubscribe}>
            <BellOff size={14} /> Désactiver
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <BellOff size={18} color="var(--muted)" />
          <span style={{ fontSize: 13, flex: 1 }}>Recevoir une notification quand le menu est modifié</span>
          <button className="btn btn-primary" onClick={subscribe}>
            <Bell size={14} /> Activer
          </button>
        </div>
      )}
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from({ length: raw.length }, (_, i) => raw.charCodeAt(i));
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const root = document.getElementById("root")!;
createRoot(root).render(<App />);
