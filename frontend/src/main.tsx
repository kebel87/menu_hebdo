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
  Pencil,
  Trash2,
  CheckCircle,
  Bell,
  BellOff,
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
  tags: string[];
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

interface CanonicalTag {
  id: string;
  name: string;
  description: string;
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function api<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
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
              { id: "recipes", label: "Recettes", icon: <UtensilsCrossed size={14} /> },
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
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [pickerDate, setPickerDate] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

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

  const slotByDate = (iso: string) => slots.find((s) => s.slot_date === iso);

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
      // déplace vers un slot vide → met le slot A à la date B
      try {
        const updated = await api<MealSlot>(`/api/week/${weekStart}/slot/${dateB}`, {
          method: "PUT",
          body: JSON.stringify({
            recipe_source: slotA.recipe_source,
            recipe_name: slotA.recipe_name,
            mealie_slug: slotA.mealie_slug,
            local_recipe_id: slotA.local_recipe_id,
            makes_lunch: slotA.makes_lunch,
            notes: slotA.notes,
          }),
        });
        await api(`/api/week/${weekStart}/slot/${dateA}`, { method: "DELETE" });
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

  async function handleAssign(slotDate: string, recipe: Recipe) {
    try {
      const body: Record<string, unknown> = {
        recipe_source: recipe.source,
        recipe_name: recipe.name,
        makes_lunch: recipe.makes_lunch,
      };
      if (recipe.source === "mealie") body.mealie_slug = recipe.slug;
      if (recipe.source === "local") body.local_recipe_id = recipe.id;
      const updated = await api<MealSlot>(`/api/week/${weekStart}/slot/${slotDate}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setSlots((prev) => [
        ...prev.filter((s) => s.slot_date !== slotDate),
        updated,
      ]);
    } catch {}
    setPickerDate(null);
  }

  async function handleClear(slotDate: string) {
    try {
      await api(`/api/week/${weekStart}/slot/${slotDate}`, { method: "DELETE" });
      setSlots((prev) => prev.filter((s) => s.slot_date !== slotDate));
    } catch {}
  }

  async function handleSidesUpdate(slotId: string, sides: SlotSide[]) {
    try {
      const updated = await api<SlotSide[]>(`/api/slots/${slotId}/sides`, {
        method: "PUT",
        body: JSON.stringify(sides.map((s) => ({ side_id: s.side_id, free_text: s.free_text || s.name }))),
      });
      setSlots((prev) =>
        prev.map((s) => (s.id === slotId ? { ...s, sides: updated } : s))
      );
    } catch {}
  }

  return (
    <div className="week-screen">
      <div className="week-nav">
        <button onClick={() => setMonday((m) => addWeeks(m, -1))}>
          <ChevronLeft size={16} />
        </button>
        <span className="week-label">{fmtWeekLabel(monday)}</span>
        {!isCurrentWeek && (
          <button className="today-btn" onClick={() => setMonday(mondayOf(today))}>
            Aujourd'hui
          </button>
        )}
        <button onClick={() => setMonday((m) => addWeeks(m, 1))}>
          <ChevronRight size={16} />
        </button>
      </div>

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
            const expanded = expandedDate === iso;
            const isOver = overId === `drop-${iso}`;

            return (
              <DroppableCard key={iso} slotDate={iso} isOver={isOver}>
                <DraggableCard slotDate={iso} slot={slot}>
                  <div
                    className={`day-card-header${isToday ? " today" : ""}`}
                    onClick={() => {
                      if (expanded) setExpandedDate(null);
                      else setExpandedDate(iso);
                    }}
                  >
                    <span className="day-name">{DAYS_FR[i]}</span>
                    <span className="day-date">{d.getDate()}</span>
                    <div className="day-badges">
                      {slot?.makes_lunch && <span className="badge badge-lunch">L</span>}
                      {slot && slot.inventory_score?.score !== undefined && (
                        <span className={`badge ${scoreClass(slot.inventory_score?.score)}`}>
                          {scoreLabel(slot.inventory_score?.score)}
                        </span>
                      )}
                    </div>
                    {canEdit && (
                      <div style={{ display: "flex", gap: 2, marginLeft: "auto" }}>
                        <button
                          className="btn-icon"
                          onClick={(e) => { e.stopPropagation(); setPickerDate(iso); }}
                          title="Choisir un repas"
                        >
                          <Pencil size={13} />
                        </button>
                        {slot && (
                          <button
                            className="btn-icon"
                            onClick={(e) => { e.stopPropagation(); handleClear(iso); }}
                            title="Retirer"
                          >
                            <X size={13} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className={`day-card-body${!slot ? " empty" : ""}`}>
                    <span className="meal-name">
                      {slot ? slot.recipe_name : "— "}
                    </span>
                  </div>
                  {expanded && slot && (
                    <SidesPanel
                      slot={slot}
                      canEdit={canEdit}
                      onUpdate={(sides) => handleSidesUpdate(slot.id, sides)}
                    />
                  )}
                </DraggableCard>
              </DroppableCard>
            );
          })}
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

      {pickerDate && (
        <RecipePicker
          date={pickerDate}
          onSelect={(r) => handleAssign(pickerDate, r)}
          onClose={() => setPickerDate(null)}
        />
      )}
    </div>
  );
}

// ─── SidesPanel ───────────────────────────────────────────────────────────────

function SidesPanel({
  slot,
  canEdit,
  onUpdate,
}: {
  slot: MealSlot;
  canEdit: boolean;
  onUpdate: (sides: SlotSide[]) => void;
}) {
  const [input, setInput] = useState("");
  const [libSides, setLibSides] = useState<Side[]>([]);

  useEffect(() => {
    api<Side[]>("/api/sides").then(setLibSides).catch(() => {});
  }, []);

  const suggestions = input.length > 0
    ? libSides.filter((s) => s.name.toLowerCase().includes(input.toLowerCase()))
    : libSides.slice(0, 5);

  function addSide(name: string, sideId?: string) {
    const newSide: SlotSide = {
      id: `tmp-${Date.now()}`,
      side_id: sideId,
      name,
      free_text: sideId ? "" : name,
      category: libSides.find((s) => s.id === sideId)?.category ?? "",
      sort_order: slot.sides.length,
    };
    onUpdate([...slot.sides, newSide]);
    setInput("");
  }

  function removeSide(sideId: string) {
    onUpdate(slot.sides.filter((s) => s.id !== sideId));
  }

  return (
    <div className="sides-panel" onClick={(e) => e.stopPropagation()}>
      <div className="sides-list">
        {slot.sides.map((s) => (
          <span key={s.id} className="side-chip">
            {s.name}
            {canEdit && (
              <button onClick={() => removeSide(s.id)} title="Retirer">
                <X size={11} />
              </button>
            )}
          </span>
        ))}
        {slot.sides.length === 0 && (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Aucun accompagnement</span>
        )}
      </div>
      {canEdit && (
        <div className="sides-add">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ajouter un accompagnement…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && input.trim()) addSide(input.trim());
            }}
          />
          <button onClick={() => input.trim() && addSide(input.trim())}>
            <Plus size={14} />
          </button>
        </div>
      )}
      {canEdit && input && suggestions.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
          {suggestions.map((s) => (
            <button
              key={s.id}
              className="filter-chip"
              onClick={() => addSide(s.name, s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── RecipePicker (modal) ─────────────────────────────────────────────────────

function RecipePicker({
  date,
  onSelect,
  onClose,
}: {
  date: string;
  onSelect: (r: Recipe) => void;
  onClose: () => void;
}) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api<Recipe[]>("/api/recipes")
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

  const filtered = recipes.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q.toLowerCase())) return false;
    if (filters.has("weekend") && !r.is_weekend) return false;
    if (filters.has("lunchs") && !r.makes_lunch) return false;
    if (filters.has("rapide") && (!r.prep_minutes || r.prep_minutes > 30)) return false;
    if (filters.has("dispo") && (r.inventory_score?.score ?? 0) < 0.8) return false;
    return true;
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <span className="modal-title" style={{ flex: 1 }}>
            Choisir un repas — {fmtDateFull(date)}
          </span>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="search-bar">
          <Search size={16} style={{ alignSelf: "center", color: "var(--muted)" }} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher une recette…"
          />
        </div>
        <div className="filter-chips">
          {["dispo", "weekend", "lunchs", "rapide"].map((f) => (
            <button
              key={f}
              className={`filter-chip${filters.has(f) ? " active" : ""}`}
              onClick={() => toggleFilter(f)}
            >
              {f === "dispo" ? "Disponible" : f === "lunchs" ? "Fait des lunchs" : f === "rapide" ? "< 30 min" : "Week-end"}
            </button>
          ))}
        </div>
        {loading ? (
          <div className="empty-state"><RefreshCw size={24} className="spin" /></div>
        ) : (
          <div className="recipe-list">
            {filtered.length === 0 && (
              <div className="empty-state"><p>Aucune recette trouvée</p></div>
            )}
            {filtered.map((r) => {
              const key = r.source === "mealie" ? `mealie-${r.slug}` : `local-${r.id}`;
              return (
                <div key={key} className="recipe-card" onClick={() => onSelect(r)}>
                  <div className="recipe-card-header">
                    <span className="recipe-card-name">{r.name}</span>
                    <span className={`source-badge ${r.source}`}>
                      {r.source === "mealie" ? "Mealie" : "Local"}
                    </span>
                  </div>
                  <div className="recipe-card-meta">
                    {r.makes_lunch && <span className="badge badge-lunch">L</span>}
                    {r.is_weekend && <span className="badge badge-weekend">WE</span>}
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
    if (filters.has("weekend") && !r.is_weekend) return false;
    if (filters.has("lunchs") && !r.makes_lunch) return false;
    if (filters.has("rapide") && (!r.prep_minutes || r.prep_minutes > 30)) return false;
    if (filters.has("dispo") && (r.inventory_score?.score ?? 0) < 0.8) return false;
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
        {["dispo", "weekend", "lunchs", "rapide", "masquees"].map((f) => (
          <button
            key={f}
            className={`filter-chip${filters.has(f) ? " active" : ""}`}
            onClick={() => toggleFilter(f)}
          >
            {f === "dispo" ? "Disponible" : f === "lunchs" ? "Fait des lunchs" : f === "rapide" ? "< 30 min" : f === "masquees" ? "Masquées" : "Week-end"}
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
                  {r.makes_lunch && <span className="badge badge-lunch">L</span>}
                  {r.is_weekend && <span className="badge badge-weekend">WE</span>}
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
  const [isWeekend, setIsWeekend] = useState(recipe.is_weekend);
  const [makesLunch, setMakesLunch] = useState(recipe.makes_lunch);
  const [isHidden, setIsHidden] = useState(recipe.is_hidden);
  const [saving, setSaving] = useState(false);

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
          body: JSON.stringify({ is_weekend: isWeekend, makes_lunch: makesLunch }),
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
          <span className="modal-title" style={{ flex: 1 }}>{recipe.name}</span>
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
        {canEdit && (
          <>
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
              <button className="btn btn-primary" onClick={save} disabled={saving}>
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
  const [saving, setSaving] = useState(false);

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
    api<CanonicalTag[]>("/api/tags").then(setTags).catch(() => {});
  }, []);

  async function addTag() {
    if (!newName.trim()) return;
    const t = await api<CanonicalTag>("/api/tags", {
      method: "POST",
      body: JSON.stringify({ name: newName.trim() }),
    });
    setTags((prev) => [...prev, t]);
    setNewName("");
  }

  async function deleteTag(id: string) {
    await api(`/api/tags/${id}`, { method: "DELETE" });
    setTags((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <div className="settings-section">
      <h2>Tags canoniques</h2>
      <div className="sides-list" style={{ marginBottom: 8 }}>
        {tags.map((t) => (
          <span key={t.id} className="side-chip">
            {t.name}
            <button onClick={() => deleteTag(t.id)} title="Supprimer">
              <X size={11} />
            </button>
          </span>
        ))}
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
