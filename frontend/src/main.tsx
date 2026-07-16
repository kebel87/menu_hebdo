import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
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
  ChevronDown,
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
  Salad,
  Eye,
  EyeOff,
  Pencil,
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
  slot_kind: "recipe" | "away" | "hosting" | "restaurant";
  context_id?: string;
  context?: MealContext;
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
    ingredients_declared?: boolean;
    ingredients_linked?: boolean;
  };
}

interface SlotSide {
  id: string;
  side_id?: string;
  name: string;
  free_text: string;
  sort_order: number;
}

interface MealPlan {
  id: string;
  week_start: string;
  created_at: string;
}

interface Child {
  id: string;
  name: string;
  short_label: string;
  color: string;
}

interface DayPresence {
  date: string;
  presentChildren: string[];
  presence: Record<string, boolean>;
  anyonePresent: boolean;
  everyonePresent: boolean;
}

interface Recipe {
  source: "mealie" | "local";
  id?: string;
  slug?: string;
  name: string;
  tags: CanonicalTag[];
  tag_ids?: string[];
  liked_by: string[];
  is_weekend: boolean;
  makes_lunch: boolean;
  is_hidden: boolean;
  prep_minutes?: number;
  notes: string;
  image?: string;
  ingredients?: Ingredient[];
  inventory_score?: {
    score: number | null;
    missing: string[];
    available: string[];
    ingredients_declared?: boolean;
    ingredients_linked?: boolean;
  };
  total_count?: number;
  last_used?: string | null;
}

interface Side {
  id: string;
  name: string;
}

interface SideStat extends Side {
  is_active: boolean;
  created_at: string;
  total_count: number;
  last_used: string | null;
  is_favorite: boolean;
}

interface FavoriteSide {
  name: string;
  side_id?: string;
}

interface MealContext {
  id: string;
  kind: "people" | "restaurant";
  name: string;
  is_active: boolean;
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

interface Ingredient {
  name: string;
  quantity?: number | null;
  unit?: string;
  canonical_ingredient_id?: string | null;
}

interface CanonicalIngredient {
  id: string;
  name: string;
  created_at: string;
}

interface IngredientMapping {
  mealie_ingredient_text: string;
  canonical_ingredient_id?: string;
  canonical_ingredient_name?: string;
  status: "pending" | "confirmed" | "ignored";
}

interface IngredientInventoryLink {
  id: string;
  canonical_ingredient_id: string;
  inventory_product_id: string;
  inventory_product_name: string;
  domain: string;
  is_live?: boolean;
}

interface InventoryProduct {
  product_id: string;
  name: string;
  domain: string;
  unit: string;
  quantity: number;
  stock_quantity?: number;
  stock_unit?: string;
  available_quantity?: number;
  available_unit?: string;
  consumption_mode?: string;
  package_content_unit?: string;
  source_product_ids?: string[];
  format_summary?: string;
}

interface NotificationConfig {
  vapid_public_key: string;
  enabled: boolean;
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

interface SideFreqEntry {
  name: string;
  side_id?: string;
  count: number;
  last_date: string;
}

interface MealSideAssociation {
  recipe_name: string;
  side_name: string;
  side_id?: string;
  count: number;
  last_date: string;
}

interface ContextStatEntry {
  kind: "away" | "hosting" | "restaurant";
  context_id?: string;
  name: string;
  count: number;
  last_date: string;
}

interface ContextStats {
  summary: Record<"away" | "hosting" | "restaurant", number>;
  by_kind: Record<"away" | "hosting" | "restaurant", ContextStatEntry[]>;
}

type SlotKind = MealSlot["slot_kind"];
type WizardResult = {
  slotKind: SlotKind;
  contextId?: string;
  contextName?: string;
  recipe: Recipe | null;
  sides: SlotSide[] | null;
};

type ViewMode = "week" | "recipes" | "sides" | "stats" | "settings";

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

const RECIPES_WITH_HIDDEN_URL = "/api/recipes?include_hidden=true";
let recipeListCache: Recipe[] | null = null;
let recipeListPromise: Promise<Recipe[]> | null = null;
let sideStatsCache: SideStat[] | null = null;
let sideStatsPromise: Promise<SideStat[]> | null = null;
const statsCache = new Map<number, { freq: FreqEntry[]; sideFreq: SideFreqEntry[]; associations: MealSideAssociation[]; contextStats: ContextStats }>();
const statsPromises = new Map<number, Promise<{ freq: FreqEntry[]; sideFreq: SideFreqEntry[]; associations: MealSideAssociation[]; contextStats: ContextStats }>>();
let tagMappingsCache: TagMapping[] | null = null;
let tagMappingsPromise: Promise<TagMapping[]> | null = null;
let canonicalTagsCache: CanonicalTag[] | null = null;
let canonicalTagsPromise: Promise<CanonicalTag[]> | null = null;
let childrenCache: Child[] | null = null;
let childrenPromise: Promise<Child[]> | null = null;
let familyMembersCache: Child[] | null = null;
let familyMembersPromise: Promise<Child[]> | null = null;
let mealContextsCache: MealContext[] | null = null;
let mealContextsPromise: Promise<MealContext[]> | null = null;
let notificationConfigCache: NotificationConfig | null = null;
let notificationConfigPromise: Promise<NotificationConfig> | null = null;
let ingredientMappingsCache: IngredientMapping[] | null = null;
let ingredientMappingsPromise: Promise<IngredientMapping[]> | null = null;
let canonicalIngredientsCache: CanonicalIngredient[] | null = null;
let canonicalIngredientsPromise: Promise<CanonicalIngredient[]> | null = null;
let ingredientLinksCache: IngredientInventoryLink[] | null = null;
let ingredientLinksPromise: Promise<IngredientInventoryLink[]> | null = null;
let inventoryProductsCache: InventoryProduct[] | null = null;
let inventoryProductsPromise: Promise<InventoryProduct[]> | null = null;

function loadRecipeList(): Promise<Recipe[]> {
  if (recipeListCache) return Promise.resolve(recipeListCache);
  if (!recipeListPromise) {
    recipeListPromise = api<Recipe[]>(RECIPES_WITH_HIDDEN_URL)
      .then((recipes) => {
        recipeListCache = recipes;
        return recipes;
      })
      .finally(() => {
        recipeListPromise = null;
      });
  }
  return recipeListPromise;
}

function prefetchRecipeList() {
  loadRecipeList().catch(() => undefined);
}

function replaceRecipeListCache(updater: (recipes: Recipe[]) => Recipe[]) {
  if (recipeListCache) recipeListCache = updater(recipeListCache);
}

function invalidateRecipeListCache() {
  recipeListCache = null;
  recipeListPromise = null;
}

function loadSideStats(): Promise<SideStat[]> {
  if (sideStatsCache) return Promise.resolve(sideStatsCache);
  if (!sideStatsPromise) {
    sideStatsPromise = api<SideStat[]>("/api/sides/stats")
      .then((sides) => {
        sideStatsCache = sides;
        return sides;
      })
      .finally(() => {
        sideStatsPromise = null;
      });
  }
  return sideStatsPromise;
}

function prefetchSideStats(canEdit: boolean) {
  if (canEdit) loadSideStats().catch(() => undefined);
}

function replaceSideStatsCache(updater: (sides: SideStat[]) => SideStat[]) {
  if (sideStatsCache) sideStatsCache = updater(sideStatsCache);
}

function invalidateSideStatsCache() {
  sideStatsCache = null;
  sideStatsPromise = null;
}

function loadStats(weeks: number): Promise<{ freq: FreqEntry[]; sideFreq: SideFreqEntry[]; associations: MealSideAssociation[]; contextStats: ContextStats }> {
  const cached = statsCache.get(weeks);
  if (cached) return Promise.resolve(cached);
  const pending = statsPromises.get(weeks);
  if (pending) return pending;
  const promise = Promise.all([
    api<FreqEntry[]>(`/api/stats/frequency?weeks=${weeks}`),
    api<SideFreqEntry[]>(`/api/stats/sides-frequency?weeks=${weeks}`),
    api<MealSideAssociation[]>(`/api/stats/meal-side-associations?weeks=${weeks}`),
    api<ContextStats>(`/api/stats/contexts?weeks=${weeks}`),
  ])
    .then(([freq, sideFreq, associations, contextStats]) => {
      const stats = { freq, sideFreq, associations, contextStats };
      statsCache.set(weeks, stats);
      return stats;
    })
    .finally(() => {
      statsPromises.delete(weeks);
    });
  statsPromises.set(weeks, promise);
  return promise;
}

function prefetchStats() {
  loadStats(12).catch(() => undefined);
}

function byName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toLocaleString("fr-CA", { maximumFractionDigits: 2 });
}

function inventoryProductAvailableLabel(product: InventoryProduct): string {
  const usefulQty = product.available_quantity ?? product.quantity;
  const usefulUnit = product.available_unit || product.unit;
  return `${formatNumber(usefulQty)} ${usefulUnit}`.trim();
}

function inventoryProductFormatLabel(product: InventoryProduct): string {
  if (product.format_summary) return product.format_summary;
  const usefulQty = product.available_quantity ?? product.quantity;
  const usefulUnit = product.available_unit || product.unit;
  const stockQty = product.stock_quantity;
  const stockUnit = product.stock_unit || product.unit;
  if (
    stockQty !== undefined &&
    stockUnit &&
    (stockUnit !== usefulUnit || Math.abs(stockQty - usefulQty) > 0.001)
  ) {
    return `${formatNumber(stockQty)} ${stockUnit}`;
  }
  return "";
}

function loadTagMappings(): Promise<TagMapping[]> {
  if (tagMappingsCache) return Promise.resolve(tagMappingsCache);
  if (!tagMappingsPromise) {
    tagMappingsPromise = api<TagMapping[]>("/api/tag-mappings")
      .then((mappings) => {
        tagMappingsCache = mappings;
        return mappings;
      })
      .finally(() => { tagMappingsPromise = null; });
  }
  return tagMappingsPromise;
}

function replaceTagMappingsCache(updater: (mappings: TagMapping[]) => TagMapping[]) {
  if (tagMappingsCache) tagMappingsCache = updater(tagMappingsCache);
}

function loadCanonicalTags(): Promise<CanonicalTag[]> {
  if (canonicalTagsCache) return Promise.resolve(canonicalTagsCache);
  if (!canonicalTagsPromise) {
    canonicalTagsPromise = api<CanonicalTag[]>("/api/tags")
      .then((tags) => {
        canonicalTagsCache = byName(tags);
        return canonicalTagsCache;
      })
      .finally(() => { canonicalTagsPromise = null; });
  }
  return canonicalTagsPromise;
}

function replaceCanonicalTagsCache(updater: (tags: CanonicalTag[]) => CanonicalTag[]) {
  canonicalTagsCache = byName(updater(canonicalTagsCache ?? []));
}

function loadChildren(): Promise<Child[]> {
  if (childrenCache) return Promise.resolve(childrenCache);
  if (!childrenPromise) {
    childrenPromise = api<Child[]>("/api/children")
      .then((children) => {
        childrenCache = children;
        return children;
      })
      .finally(() => { childrenPromise = null; });
  }
  return childrenPromise;
}

function replaceChildrenCache(updater: (children: Child[]) => Child[]) {
  if (childrenCache) childrenCache = updater(childrenCache);
}

function loadFamilyMembers(): Promise<Child[]> {
  if (familyMembersCache) return Promise.resolve(familyMembersCache);
  if (!familyMembersPromise) {
    familyMembersPromise = api<Child[]>("/api/family-members")
      .then((members) => {
        familyMembersCache = byName(members);
        return familyMembersCache;
      })
      .finally(() => { familyMembersPromise = null; });
  }
  return familyMembersPromise;
}

function replaceFamilyMembersCache(updater: (members: Child[]) => Child[]) {
  familyMembersCache = byName(updater(familyMembersCache ?? []));
}

function loadMealContexts(): Promise<MealContext[]> {
  if (mealContextsCache) return Promise.resolve(mealContextsCache);
  if (!mealContextsPromise) {
    mealContextsPromise = api<MealContext[]>("/api/meal-contexts?include_inactive=true")
      .then((contexts) => {
        mealContextsCache = byName(contexts);
        return mealContextsCache;
      })
      .finally(() => { mealContextsPromise = null; });
  }
  return mealContextsPromise;
}

function replaceMealContextsCache(updater: (contexts: MealContext[]) => MealContext[]) {
  mealContextsCache = byName(updater(mealContextsCache ?? []));
}

function loadNotificationConfig(): Promise<NotificationConfig> {
  if (notificationConfigCache) return Promise.resolve(notificationConfigCache);
  if (!notificationConfigPromise) {
    notificationConfigPromise = api<NotificationConfig>("/api/notifications/config")
      .then((config) => {
        notificationConfigCache = config;
        return config;
      })
      .finally(() => { notificationConfigPromise = null; });
  }
  return notificationConfigPromise;
}

function loadIngredientMappings(): Promise<IngredientMapping[]> {
  if (ingredientMappingsCache) return Promise.resolve(ingredientMappingsCache);
  if (!ingredientMappingsPromise) {
    ingredientMappingsPromise = api<IngredientMapping[]>("/api/ingredient-mappings")
      .then((mappings) => {
        ingredientMappingsCache = mappings;
        return mappings;
      })
      .finally(() => { ingredientMappingsPromise = null; });
  }
  return ingredientMappingsPromise;
}

function replaceIngredientMappingsCache(updater: (mappings: IngredientMapping[]) => IngredientMapping[]) {
  if (ingredientMappingsCache) ingredientMappingsCache = updater(ingredientMappingsCache);
}

function loadCanonicalIngredients(): Promise<CanonicalIngredient[]> {
  if (canonicalIngredientsCache) return Promise.resolve(canonicalIngredientsCache);
  if (!canonicalIngredientsPromise) {
    canonicalIngredientsPromise = api<CanonicalIngredient[]>("/api/canonical-ingredients")
      .then((ingredients) => {
        canonicalIngredientsCache = byName(ingredients);
        return canonicalIngredientsCache;
      })
      .finally(() => { canonicalIngredientsPromise = null; });
  }
  return canonicalIngredientsPromise;
}

function replaceCanonicalIngredientsCache(updater: (ingredients: CanonicalIngredient[]) => CanonicalIngredient[]) {
  canonicalIngredientsCache = byName(updater(canonicalIngredientsCache ?? []));
}

function loadIngredientLinks(): Promise<IngredientInventoryLink[]> {
  if (ingredientLinksCache) return Promise.resolve(ingredientLinksCache);
  if (!ingredientLinksPromise) {
    ingredientLinksPromise = api<IngredientInventoryLink[]>("/api/ingredient-inventory-links")
      .then((links) => {
        ingredientLinksCache = links;
        return links;
      })
      .finally(() => { ingredientLinksPromise = null; });
  }
  return ingredientLinksPromise;
}

function replaceIngredientLinksCache(updater: (links: IngredientInventoryLink[]) => IngredientInventoryLink[]) {
  if (ingredientLinksCache) ingredientLinksCache = updater(ingredientLinksCache);
}

function loadInventoryProducts(): Promise<InventoryProduct[]> {
  if (inventoryProductsCache) return Promise.resolve(inventoryProductsCache);
  if (!inventoryProductsPromise) {
    inventoryProductsPromise = api<InventoryProduct[]>("/api/inventory-products")
      .then((products) => {
        inventoryProductsCache = byName(products);
        return inventoryProductsCache;
      })
      .finally(() => { inventoryProductsPromise = null; });
  }
  return inventoryProductsPromise;
}

function refreshInventoryProducts(): Promise<InventoryProduct[]> {
  inventoryProductsCache = null;
  inventoryProductsPromise = api<InventoryProduct[]>("/api/inventory-products/refresh", { method: "POST" })
    .then((products) => {
      inventoryProductsCache = byName(products);
      return inventoryProductsCache;
    })
    .finally(() => { inventoryProductsPromise = null; });
  return inventoryProductsPromise;
}

function prefetchSettings(canAdmin: boolean) {
  loadNotificationConfig().catch(() => undefined);
  if (!canAdmin) return;
  loadTagMappings().catch(() => undefined);
  loadCanonicalTags().catch(() => undefined);
  loadIngredientMappings().catch(() => undefined);
  loadCanonicalIngredients().catch(() => undefined);
  loadIngredientLinks().catch(() => undefined);
  loadChildren().catch(() => undefined);
  loadFamilyMembers().catch(() => undefined);
  loadMealContexts().catch(() => undefined);
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
      .catch(() => notify("Impossible de charger les tags de filtre."));
  }, []);
  return tags;
}

function hasTag(r: Recipe, tagId: string): boolean {
  return r.tags.some((t) => t.id === tagId);
}

function useChildren(): Child[] {
  const [children, setChildren] = useState<Child[]>([]);
  useEffect(() => {
    api<Child[]>("/api/children").then(setChildren).catch(() => notify("Impossible de charger la liste des enfants."));
  }, []);
  return children;
}

// Enfants (calendrier_familiale) + parents (locaux) : tout le monde dont les
// préférences comptent pour "aimé par". Ne pas utiliser pour la présence du
// jour (useChildren) — les parents n'ont pas de garde partagée à suivre.
function usePeople(): Child[] {
  const [people, setPeople] = useState<Child[]>([]);
  useEffect(() => {
    api<Child[]>("/api/people").then(setPeople).catch(() => notify("Impossible de charger la liste des personnes."));
  }, []);
  return people;
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
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function searchKey(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function productMatchesLink(product: InventoryProduct, inventoryProductId: string): boolean {
  return product.product_id === inventoryProductId || (product.source_product_ids ?? []).includes(inventoryProductId);
}

function unitForCanonicalIngredient(
  canonicalIngredientId: string | null | undefined,
  links: IngredientInventoryLink[],
  products: InventoryProduct[],
): string {
  if (!canonicalIngredientId) return "";
  const linkedProductIds = links
    .filter((link) => link.canonical_ingredient_id === canonicalIngredientId)
    .map((link) => link.inventory_product_id);
  for (const linkedProductId of linkedProductIds) {
    const product = products.find((candidate) => productMatchesLink(candidate, linkedProductId));
    const unit = product?.available_unit || product?.unit || product?.stock_unit || "";
    if (unit.trim()) return unit.trim();
  }
  return "";
}

function resolveCanonicalIngredient(ingredient: Ingredient, allIngredients: CanonicalIngredient[]): CanonicalIngredient | undefined {
  if (ingredient.canonical_ingredient_id) {
    return allIngredients.find((candidate) => candidate.id === ingredient.canonical_ingredient_id) ?? (
      ingredient.name.trim()
        ? { id: ingredient.canonical_ingredient_id, name: ingredient.name.trim(), created_at: "" }
        : undefined
    );
  }
  const ingredientKey = searchKey(ingredient.name.trim());
  if (!ingredientKey) return undefined;
  return allIngredients.find((candidate) => searchKey(candidate.name) === ingredientKey);
}

function normalizeLocalRecipeIngredients(
  ingredients: Ingredient[],
  allIngredients: CanonicalIngredient[],
  links: IngredientInventoryLink[],
  products: InventoryProduct[],
): Ingredient[] {
  return ingredients.flatMap((ingredient) => {
    const canonicalIngredient = resolveCanonicalIngredient(ingredient, allIngredients);
    if (!canonicalIngredient) return [];
    return [{
      name: canonicalIngredient.name,
      quantity: ingredient.quantity ?? null,
      unit: unitForCanonicalIngredient(canonicalIngredient.id, links, products) || ingredient.unit || "",
      canonical_ingredient_id: canonicalIngredient.id,
    }];
  });
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

function slotKindLabel(kind?: SlotKind): string {
  if (kind === "away") return "Ailleurs";
  if (kind === "hosting") return "On reçoit";
  if (kind === "restaurant") return "Resto";
  return "Maison";
}

function slotTitle(slot: MealSlot): string {
  if (slot.slot_kind === "away") return `Chez ${slot.context?.name ?? slot.recipe_name}`;
  if (slot.slot_kind === "restaurant") return slot.context?.name ?? slot.recipe_name;
  return slot.recipe_name;
}

function slotSubtitle(slot: MealSlot): string {
  if (slot.slot_kind === "hosting") return `Reçoit ${slot.context?.name ?? "famille"}`;
  if (slot.slot_kind === "restaurant") return "Restaurant";
  if (slot.sides.length > 0) return slot.sides.map((s) => s.name).join(", ");
  return "";
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

function presenceTagStyle(child?: Child): React.CSSProperties {
  const bg = child?.color || DEFAULT_TAG_COLOR;
  return { background: bg, color: readableTextColor(bg) };
}

function PresenceBadge({
  dayPresence,
  allChildren,
}: {
  dayPresence?: DayPresence;
  allChildren: Child[];
}) {
  if (!dayPresence || dayPresence.presentChildren.length === 0) return null;
  if (dayPresence.everyonePresent) {
    return <span className="presence-tag presence-tag-all">Tous</span>;
  }
  return (
    <span className="presence-tags">
      {dayPresence.presentChildren.map((childId) => {
        const child = allChildren.find((c) => c.id === childId);
        return (
          <span key={childId} className="presence-tag" style={presenceTagStyle(child)} title={child?.name ?? childId}>
            {child?.short_label ?? childId[0]?.toUpperCase()}
          </span>
        );
      })}
    </span>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

// ─── Toasts ─────────────────────────────────────────────────────────────────

type Toast = { id: number; text: string; kind: "error" | "info" };

let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();
let toastIdSeq = 0;

function emitToasts() {
  for (const listener of toastListeners) listener();
}

function notify(text: string, kind: Toast["kind"] = "error") {
  const id = ++toastIdSeq;
  toasts = [...toasts, { id, text, kind }];
  emitToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emitToasts();
  }, 4000);
}

function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emitToasts();
}

function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      toastListeners.add(cb);
      return () => toastListeners.delete(cb);
    },
    () => toasts
  );
}

function ToastContainer() {
  const items = useToasts();
  if (!items.length) return null;
  return (
    <div className="toast-container">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          onClick={() => dismissToast(t.id)}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [view, setView] = useState<ViewMode>("week");
  const [error, setError] = useState("");

  const canEdit = user?.permissions.includes("menu.edit") ?? false;
  const canAdmin = user?.permissions.includes("settings.manage") ?? false;

  useEffect(() => {
    api<CurrentUser>("/api/me")
      .then((currentUser) => {
        setUser(currentUser);
        prefetchRecipeList();
        prefetchSideStats(currentUser.permissions.includes("menu.edit"));
        prefetchStats();
        prefetchSettings(currentUser.permissions.includes("settings.manage"));
      })
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
              ...(canEdit
                ? [{ id: "sides", label: "Accomp.", icon: <Salad size={14} /> }]
                : []),
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
        {view === "sides" && canEdit && <SidesScreen />}
        {view === "stats" && <StatsScreen />}
        {view === "settings" && <SettingsScreen canAdmin={canAdmin} />}
      </div>
      <ToastContainer />
    </div>
  );
}

// ─── WeekScreen ───────────────────────────────────────────────────────────────

function WeekScreen({ canEdit }: { canEdit: boolean }) {
  const today = new Date();
  const [monday, setMonday] = useState<Date>(() => mondayOf(today));
  const [plan, setPlan] = useState<MealPlan | null>(null);
  const [slots, setSlots] = useState<MealSlot[]>([]);
  const [presence, setPresence] = useState<Record<string, DayPresence>>({});
  const [loading, setLoading] = useState(false);
  const children = useChildren();
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
      const data = await api<{ plan: MealPlan; slots: MealSlot[]; presence?: Record<string, DayPresence> }>(
        `/api/week/${weekStart}`
      );
      setPlan(data.plan);
      setSlots(data.slots);
      setPresence(data.presence ?? {});
    } catch {
      notify("Impossible de charger la semaine.");
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
      notify("Impossible de charger le mois.");
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
      } catch {
        notify("Impossible de déplacer le repas.");
      }
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
    } catch {
      notify("Impossible d'échanger les repas.");
    }
  }

  async function handleClear(slotDate: string) {
    try {
      await api(`/api/week/${weekStart}/slot/${slotDate}`, { method: "DELETE" });
      setSlots((prev) => prev.filter((s) => s.slot_date !== slotDate));
    } catch {
      notify("Impossible de retirer le repas.");
    }
  }

  async function handleWizardComplete(slotDate: string, result: WizardResult) {
    try {
      let updated: MealSlot | null = null;
      if (result.slotKind === "away" || result.slotKind === "restaurant") {
        updated = await api<MealSlot>(`/api/week/${weekStart}/slot/${slotDate}`, {
          method: "PUT",
          body: JSON.stringify({
            slot_kind: result.slotKind,
            context_id: result.contextId,
            recipe_source: "free",
            recipe_name: result.contextName,
          }),
        });
        setSlots((prev) => [...prev.filter((s) => s.slot_date !== slotDate), updated!]);
      } else if (result.recipe) {
        const body: Record<string, unknown> = {
          slot_kind: result.slotKind,
          context_id: result.contextId,
          recipe_source: result.recipe.source,
          recipe_name: result.recipe.name,
          makes_lunch: result.recipe.makes_lunch,
        };
        if (result.recipe.source === "mealie") body.mealie_slug = result.recipe.slug;
        if (result.recipe.source === "local") body.local_recipe_id = result.recipe.id;
        updated = await api<MealSlot>(`/api/week/${weekStart}/slot/${slotDate}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        setSlots((prev) => [...prev.filter((s) => s.slot_date !== slotDate), updated!]);
      }
      if (result.sides !== null && result.slotKind !== "away" && result.slotKind !== "restaurant") {
        const slotId = updated?.id ?? slotByDate(slotDate)?.id;
        if (slotId) {
          const savedSides = await api<SlotSide[]>(`/api/slots/${slotId}/sides`, {
            method: "PUT",
            body: JSON.stringify(result.sides.map((s) => ({ side_id: s.side_id, free_text: s.free_text || s.name }))),
          });
          setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, sides: savedSides } : s)));
        }
      }
    } catch {
      notify("Impossible d'enregistrer le repas.");
    }
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
              if (slot) setWizard({ date: iso, mode: "edit" });
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
                    <PresenceBadge dayPresence={presence[iso]} allChildren={children} />
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
                        {slot ? slotTitle(slot) : "— "}
                      </span>
                      {slot && slotSubtitle(slot) && (
                        <span className="meal-sides">
                          {slotSubtitle(slot)}
                        </span>
                      )}
                    </div>
                    <div className="day-badges">
                      {slot && slot.slot_kind !== "recipe" && (
                        <span className={`badge badge-context badge-${slot.slot_kind}`}>
                          {slotKindLabel(slot.slot_kind)}
                        </span>
                      )}
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
                      {slot?.slot_kind !== "away" && slot?.slot_kind !== "restaurant" && slot?.makes_lunch && <span className="badge badge-lunch">Lunch</span>}
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
                <span className="meal-name">{slotTitle(slotByDate(activeId)!)}</span>
              </div>
            </div>
          )}
        </DragOverlay>
      </DndContext>
      )}

      {wizard && (
        <MealWizard
          date={wizard.date}
          slot={slotByDate(wizard.date)}
          mode={wizard.mode}
          canEdit={canEdit}
          onComplete={(result) => handleWizardComplete(wizard.date, result)}
          onClear={() => {
            handleClear(wizard.date);
            setWizard(null);
          }}
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
              {slot && <span className="event-label">{slotTitle(slot)}</span>}
              {slot?.slot_kind !== "away" && slot?.slot_kind !== "restaurant" && slot?.makes_lunch && <span className="month-lunch-dot" aria-hidden="true" title="Fait des lunchs" />}
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
      .catch(() => {
        setSlots([]);
        notify("Impossible de charger le calendrier.");
      });
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
    api<Side[]>("/api/sides").then(setLibSides).catch(() => notify("Impossible de charger la bibliothèque d'accompagnements."));
    api<FavoriteSide[]>("/api/sides/favorites").then(setFavorites).catch(() => notify("Impossible de charger les accompagnements favoris."));
  }, []);

  const suggestions = input.length > 0
    ? libSides.filter((s) => searchKey(s.name).includes(searchKey(input)))
    : libSides.slice(0, 8);
  const exactMatch = suggestions.some((s) => s.name.toLowerCase() === input.trim().toLowerCase());
  const chosenNames = new Set(sides.map((s) => s.name.toLowerCase()));

  function addSide(name: string, sideId?: string) {
    onChange([...sides, {
      id: `tmp-${Date.now()}`,
      side_id: sideId,
      name,
      free_text: sideId ? "" : name,
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

// ─── MealWizard (modal, choix du repas puis de l'accompagnement) ──────────────

type WizardMode = "new" | "edit" | "meal" | "sides" | "both";

function MealWizard({
  date,
  slot,
  mode,
  canEdit,
  onComplete,
  onClear,
  onClose,
}: {
  date: string;
  slot?: MealSlot;
  mode: WizardMode;
  canEdit: boolean;
  onComplete: (result: WizardResult) => void;
  onClear?: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"edit" | "meal" | "sides" | "confirm">(
    mode === "edit" ? "edit" : mode === "sides" ? "sides" : "meal"
  );
  const [slotKind, setSlotKind] = useState<SlotKind>(slot?.slot_kind ?? "recipe");
  const [contextId, setContextId] = useState(slot?.context_id ?? "");
  const [chosenRecipe, setChosenRecipe] = useState<Recipe | null>(null);
  const [chosenSides, setChosenSides] = useState<SlotSide[]>(
    mode === "meal" || mode === "sides" || mode === "edit" ? (slot?.sides ?? []) : []
  );
  const [mealChanged, setMealChanged] = useState(false);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [favorites, setFavorites] = useState<Recipe[]>([]);
  const [contexts, setContexts] = useState<MealContext[]>([]);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [mealListOpen, setMealListOpen] = useState(false);
  const [showAllMeals, setShowAllMeals] = useState(false);
  const filterTags = useFilterableTags();

  useEffect(() => {
    if (mode === "sides") return;
    setLoading(true);
    api<Recipe[]>("/api/recipes")
      .then(setRecipes)
      .finally(() => setLoading(false));
    api<Recipe[]>(`/api/recipes/favorites?date=${encodeURIComponent(date)}`).then(setFavorites).catch(() => notify("Impossible de charger les recettes favorites."));
    api<MealContext[]>("/api/meal-contexts")
      .then(setContexts)
      .catch(() => notify("Impossible de charger les lieux et restaurants."));
  }, [mode, date]);

  function toggleFilter(f: string) {
    setMealListOpen(true);
    setShowAllMeals(false);
    setFilters((prev) => {
      const n = new Set(prev);
      n.has(f) ? n.delete(f) : n.add(f);
      return n;
    });
  }

  const filtered = recipes.filter((r) => {
    if (q && !searchKey(r.name).includes(searchKey(q))) return false;
    if (filters.has("rapide") && (!r.prep_minutes || r.prep_minutes > 30)) return false;
    if (filters.has("dispo") && (r.inventory_score?.score ?? 0) < 0.8) return false;
    for (const t of filterTags) {
      if (filters.has(t.id) && !hasTag(r, t.id)) return false;
    }
    return true;
  });

  const isIdle = !q && filters.size === 0;
  const mealResults = showAllMeals ? recipes : filtered;

  function pickMeal(r: Recipe) {
    setMealListOpen(false);
    setShowAllMeals(false);
    setChosenRecipe(r);
    setMealChanged(true);
    if (mode === "edit") {
      setStep("edit");
      return;
    }
    if (mode === "meal") {
      // Le repas seul change : on garde l'accompagnement existant, étape sides sautée.
      setStep("confirm");
    } else {
      setChosenSides([]);
      setStep("sides");
    }
  }

  function handleConfirm() {
    const context = contexts.find((c) => c.id === contextId);
    onComplete({
      slotKind,
      contextId: contextId || undefined,
      contextName: context?.name,
      recipe: mode === "sides" || (mode === "edit" && !mealChanged) ? null : chosenRecipe,
      sides: mode === "meal" ? null : chosenSides,
    });
  }

  const needsRecipe = slotKind === "recipe" || slotKind === "hosting";
  const needsContext = slotKind === "away" || slotKind === "hosting" || slotKind === "restaurant";
  const contextChoices = contexts.filter((c) =>
    slotKind === "restaurant" ? c.kind === "restaurant" : c.kind === "people"
  );
  const selectedContext = contexts.find((c) => c.id === contextId);
  const canConfirm = mode === "edit" || mode === "sides" || (
    (!needsContext || !!contextId) &&
    (!needsRecipe || !!chosenRecipe)
  );

  const steps = mode === "meal" ? ["Repas", "Confirmer"]
    : mode === "sides" ? ["Accompagnement", "Confirmer"]
    : needsRecipe ? ["Repas", "Accompagnement", "Confirmer"] : ["Sortie", "Confirmer"];
  const currentIndex = step === "confirm" ? steps.length - 1
    : step === "sides" ? (mode === "sides" ? 0 : 1)
    : 0;

  const confirmRecipeName = mode === "sides"
    ? slotTitle(slot!)
    : slotKind === "away"
      ? `Chez ${selectedContext?.name ?? ""}`
      : slotKind === "restaurant"
        ? selectedContext?.name
        : chosenRecipe?.name;

  function chooseSlotKind(kind: SlotKind) {
    setSlotKind(kind);
    setContextId("");
    setChosenRecipe(null);
    setChosenSides([]);
    setMealChanged(true);
    setMealListOpen(false);
    setShowAllMeals(false);
  }

  function handleContextChange(value: string) {
    setContextId(value);
    if (mode === "edit") setMealChanged(true);
  }

  function continueAfterContext() {
    if (slotKind === "away" || slotKind === "restaurant") {
      setStep(mode === "edit" ? "edit" : "confirm");
    }
  }

  const editMealLabel = chosenRecipe?.name
    ?? (slotKind === "away" ? `Chez ${selectedContext?.name ?? slot?.context?.name ?? slot?.recipe_name ?? ""}`
      : slotKind === "restaurant" ? selectedContext?.name ?? slot?.context?.name ?? slot?.recipe_name
        : slot ? slotTitle(slot) : "");
  const editCanSave = canEdit && (
    step !== "edit" || (
      (slotKind === "away" || slotKind === "restaurant")
        ? !!contextId
        : slotKind === "hosting"
          ? !!contextId && (!!chosenRecipe || !mealChanged)
          : !!chosenRecipe || !mealChanged
    )
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal${step === "meal" && needsRecipe ? " meal-picker-modal" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <span className="modal-title" style={{ flex: 1 }}>
            {mode === "edit" ? "Modifier le menu" : mode === "sides" ? "Choisir l'accompagnement" : "Choisir un repas"} — {fmtDateFull(date)}
          </span>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        {mode !== "edit" && <StepIndicator steps={steps} current={currentIndex} />}

        {step === "edit" && slot && (
          <>
            <div className="edit-meal-section">
              <div className="section-label">Repas</div>
              <div className="edit-meal-card">
                <div className="edit-meal-main">
                  <span className="edit-meal-title">{editMealLabel}</span>
                  <span className="edit-meal-subtitle">{slotKindLabel(slotKind)}</span>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => setStep("meal")}>
                  Changer
                </button>
              </div>
            </div>

            {slotKind !== "away" && slotKind !== "restaurant" && (
              <div className="edit-meal-section">
                <div className="section-label">Accompagnements</div>
                <SidesEditor sides={chosenSides} onChange={setChosenSides} />
              </div>
            )}

            <div className="form-actions edit-meal-actions">
              <button className="btn btn-danger btn-sm" onClick={onClear} disabled={!onClear || !canEdit}>
                Retirer le repas
              </button>
              <span className="edit-meal-action-spacer" />
              <button className="btn btn-secondary" onClick={onClose}>Annuler</button>
              <button className="btn btn-primary" onClick={handleConfirm} disabled={!editCanSave}>
                Enregistrer
              </button>
            </div>
          </>
        )}

        {step === "meal" && (
          <>
            {mode !== "meal" && (
              <div className="meal-kind-row">
                <span className="meal-kind-prompt">
                  {slotKind === "recipe" ? "Pas à la maison ?" : "Type"}
                </span>
                {(slotKind === "recipe"
                  ? [
                      ["away", "Chez quelqu'un"],
                      ["hosting", "On reçoit"],
                      ["restaurant", "Restaurant"],
                    ]
                  : [
                      ["recipe", "Maison"],
                      ["away", "Chez quelqu'un"],
                      ["hosting", "On reçoit"],
                      ["restaurant", "Restaurant"],
                    ]
                ).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    className={`meal-kind-btn${slotKind === kind ? " active" : ""}`}
                    onClick={() => chooseSlotKind(kind as SlotKind)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {needsContext && (
              <div className="form-row">
                <label>{slotKind === "restaurant" ? "Restaurant" : slotKind === "hosting" ? "Qui on reçoit" : "Chez qui"}</label>
                <select
                  value={contextId}
                  onChange={(e) => handleContextChange(e.target.value)}
                >
                  <option value="">Sélectionner…</option>
                  {contextChoices.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}

            {!needsRecipe && (
              <>
                <div className="form-actions">
                  <button className="btn btn-primary" onClick={continueAfterContext} disabled={!contextId}>
                    {mode === "edit" ? "Appliquer" : "Continuer"}
                  </button>
                  {mode === "edit" && (
                    <button className="btn btn-secondary" onClick={() => setStep("edit")}>
                      Retour
                    </button>
                  )}
                </div>
                {contextChoices.length === 0 && (
                  <div className="empty-state"><p>Ajoute d'abord des entrées dans les paramètres.</p></div>
                )}
              </>
            )}

            {needsRecipe && (
              <>
                <div className="meal-search-combo">
                  <div className="meal-search-row">
                    <Search size={16} style={{ color: "var(--muted)", flexShrink: 0 }} />
                    <input
                      value={q}
                      onChange={(e) => { setQ(e.target.value); setMealListOpen(true); setShowAllMeals(false); }}
                      onFocus={() => { if (q || filters.size > 0) setMealListOpen(true); }}
                      onBlur={() => setTimeout(() => setMealListOpen(false), 150)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && mealResults.length > 0) pickMeal(mealResults[0]);
                      }}
                      placeholder="Rechercher une recette…"
                    />
                    <button
                      type="button"
                      className={`meal-dropdown-btn${mealListOpen && showAllMeals ? " active" : ""}`}
                      aria-label="Afficher toutes les recettes"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setShowAllMeals(true);
                        setMealListOpen((open) => !(open && showAllMeals));
                      }}
                    >
                      <ChevronDown size={18} />
                    </button>
                  </div>
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
                {mealListOpen && (
                  loading ? (
                    <div className="meal-dropdown-panel">
                      <div className="empty-state"><RefreshCw size={24} className="spin" /></div>
                    </div>
                  ) : (
                    <div className="meal-dropdown-panel">
                      {mealResults.length === 0 && (
                        <div className="empty-state"><p>Aucune recette trouvée</p></div>
                      )}
                      {mealResults.map((r) => {
                        const key = r.source === "mealie" ? `mealie-${r.slug}` : `local-${r.id}`;
                        return (
                          <button key={key} type="button" className="meal-option" onMouseDown={() => pickMeal(r)}>
                            <span className="meal-option-name">{r.name}</span>
                            <span className="recipe-card-meta">
                              {r.makes_lunch && <span className="badge badge-lunch">Lunch</span>}
                              {r.is_weekend && <span className="badge badge-weekend">Weekend</span>}
                              {r.prep_minutes && <span className="recipe-last">{r.prep_minutes} min</span>}
                              {r.inventory_score?.score !== null && r.inventory_score?.score !== undefined && (
                                <span className={`badge ${scoreClass(r.inventory_score.score)}`}>
                                  {Math.round(r.inventory_score.score * 100)}%
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )
                )}
                {isIdle && favorites.length > 0 && !mealListOpen && (
                  <div className="favorites-row">
                    <div className="favorites-label">Favoris</div>
                    <div className="meal-favorites-grid">
                      {favorites.map((r) => {
                        const key = r.source === "mealie" ? `mealie-${r.slug}` : `local-${r.id}`;
                        return (
                          <button key={key} type="button" className="meal-favorite-card" onClick={() => pickMeal(r)}>
                            <span className="meal-option-name">{r.name}</span>
                            <span className="recipe-card-meta">
                              {r.makes_lunch && <span className="badge badge-lunch">Lunch</span>}
                              {r.is_weekend && <span className="badge badge-weekend">Weekend</span>}
                              {r.prep_minutes && <span className="recipe-last">{r.prep_minutes} min</span>}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {mode === "edit" && (
                  <div className="form-actions">
                    <button className="btn btn-secondary" onClick={() => setStep("edit")}>
                      Retour
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}

        {step === "sides" && (
          <>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>
              {mode === "sides" ? slotTitle(slot!) : chosenRecipe?.name}
            </div>
            <SidesEditor sides={chosenSides} onChange={setChosenSides} />
            <div className="form-actions">
              <button
                className="btn btn-secondary"
                onClick={() => { setChosenSides([]); setStep(mode === "edit" ? "edit" : "confirm"); }}
              >
                Aucun accompagnement
              </button>
              <button className="btn btn-primary" onClick={() => setStep(mode === "edit" ? "edit" : "confirm")}>
                {mode === "edit" ? "Appliquer" : "Continuer"}
              </button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{confirmRecipeName}</div>
              {slotKind === "hosting" && selectedContext && (
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                  Reçoit {selectedContext.name}
                </div>
              )}
              <div className="sides-list" style={{ marginTop: 6 }}>
                {slotKind === "away" || slotKind === "restaurant" ? (
                  <span className="side-chip">{slotKindLabel(slotKind)}</span>
                ) : chosenSides.length === 0 ? (
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
              <button className="btn btn-primary" onClick={handleConfirm} disabled={!canEdit || !canConfirm}>
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

type RecipeSortMode = "name" | "frequent" | "recent" | "stale" | "prep";

function RecipesScreen({ canEdit }: { canEdit: boolean }) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<RecipeSortMode>("name");
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Recipe | null>(null);
  const [showAddLocal, setShowAddLocal] = useState(false);
  const filterTags = useFilterableTags();
  const children = usePeople();

  useEffect(() => {
    loadRecipeList()
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
    if (q && !searchKey(r.name).includes(searchKey(q))) return false;
    if (filters.has("rapide") && (!r.prep_minutes || r.prep_minutes > 30)) return false;
    if (filters.has("dispo") && (r.inventory_score?.score ?? 0) < 0.8) return false;
    for (const t of filterTags) {
      if (filters.has(t.id) && !hasTag(r, t.id)) return false;
    }
    for (const c of children) {
      if (filters.has(c.id) && !r.liked_by.includes(c.id)) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    switch (sort) {
      case "frequent":
        return (b.total_count ?? 0) - (a.total_count ?? 0);
      case "recent":
        return (b.last_used ?? "").localeCompare(a.last_used ?? "");
      case "stale":
        return (a.last_used ?? "").localeCompare(b.last_used ?? "");
      case "prep":
        return (a.prep_minutes ?? Infinity) - (b.prep_minutes ?? Infinity);
      default:
        return a.name.localeCompare(b.name);
    }
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
        {children.map((c) => (
          <button
            key={c.id}
            className={`filter-chip${filters.has(c.id) ? " active" : ""}`}
            onClick={() => toggleFilter(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="sort-row">
        <label htmlFor="recipe-sort">Trier :</label>
        <select id="recipe-sort" value={sort} onChange={(e) => setSort(e.target.value as RecipeSortMode)}>
          <option value="name">Nom (A-Z)</option>
          <option value="frequent">Plus fréquent</option>
          <option value="recent">Mangé récemment</option>
          <option value="stale">Pas mangé depuis longtemps</option>
          <option value="prep">Temps de préparation</option>
        </select>
      </div>
      {loading ? (
        <div className="empty-state"><RefreshCw size={24} /></div>
      ) : (
        <div className="recipe-list">
          {sorted.length === 0 && (
            <div className="empty-state"><p>Aucune recette trouvée</p></div>
          )}
          {sorted.map((r) => {
            const key = r.source === "mealie" ? `mealie-${r.slug}` : `local-${r.id}`;
            const meta = [
              r.prep_minutes ? `${r.prep_minutes} min` : null,
              r.last_used ? weeksAgo(r.last_used) : "Jamais mangé",
            ].filter(Boolean);
            return (
              <div key={key} className="recipe-card" onClick={() => setDetail(r)}>
                <div className="recipe-card-header">
                  <span className="recipe-card-name">{r.name}</span>
                  {r.inventory_score?.score !== null && r.inventory_score?.score !== undefined && (
                    <span className={`badge recipe-card-score ${scoreClass(r.inventory_score.score)}`}>
                      {Math.round(r.inventory_score.score * 100)}% dispo
                    </span>
                  )}
                </div>
                <div className="recipe-card-meta">
                  {r.makes_lunch && <span className="recipe-card-lunch">Lunch</span>}
                  {meta.length > 0 && <span>{meta.join(" · ")}</span>}
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
            replaceRecipeListCache((prev) =>
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
            replaceRecipeListCache((prev) =>
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
            replaceRecipeListCache((prev) => [...prev, r]);
            setShowAddLocal(false);
          }}
        />
      )}
    </div>
  );
}

// ─── SidesScreen ──────────────────────────────────────────────────────────────

function SidesScreen() {
  const [sides, setSides] = useState<SideStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState("");
  const [editingSide, setEditingSide] = useState<SideStat | null>(null);

  function load() {
    setLoading(true);
    loadSideStats().then(setSides).finally(() => setLoading(false));
  }

  useEffect(load, []);

  function toggleFilter(f: string) {
    setFilters((prev) => {
      const n = new Set(prev);
      n.has(f) ? n.delete(f) : n.add(f);
      return n;
    });
  }

  const showInactive = filters.has("inactifs");
  const showCleanup = filters.has("nettoyage");
  const filtered = sides.filter((s) => {
    if (showCleanup) {
      if (s.is_active && s.total_count > 0) return false;
    } else if (showInactive) {
      if (s.is_active) return false;
    } else if (!s.is_active) {
      return false;
    }
    if (q && !searchKey(s.name).includes(searchKey(q))) return false;
    if (filters.has("favoris") && !s.is_favorite) return false;
    return true;
  });
  const visibleSides = [...filtered].sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    if (a.is_favorite !== b.is_favorite) return a.is_favorite ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const activeCount = sides.filter((s) => s.is_active).length;
  const neverUsedCount = sides.filter((s) => s.total_count === 0).length;
  const inactiveCount = sides.filter((s) => !s.is_active).length;
  const cleanupCount = neverUsedCount + inactiveCount;

  async function addSide() {
    if (!newName.trim()) return;
    await api<Side>("/api/sides", {
      method: "POST",
      body: JSON.stringify({ name: newName.trim() }),
    });
    invalidateSideStatsCache();
    setNewName("");
    load();
  }

  async function renameSide(id: string, name: string) {
    if (!name.trim()) return;
    const updated = await api<SideStat>(`/api/sides/${id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
    invalidateSideStatsCache();
    setSides((prev) => prev.map((side) => (side.id === id ? { ...side, ...updated } : side)));
    setEditingSide(null);
  }

  async function toggleActive(s: SideStat) {
    await api(`/api/sides/${s.id}`, { method: "PATCH", body: JSON.stringify({ is_active: !s.is_active }) });
    const updated = { ...s, is_active: !s.is_active };
    setSides((prev) => prev.map((side) => (side.id === s.id ? updated : side)));
    replaceSideStatsCache((prev) => prev.map((side) => (side.id === s.id ? updated : side)));
    setEditingSide((current) => (current?.id === s.id ? updated : current));
  }

  async function deleteSide(id: string) {
    await api(`/api/sides/${id}`, { method: "DELETE" });
    setSides((prev) => prev.filter((s) => s.id !== id));
    replaceSideStatsCache((prev) => prev.filter((s) => s.id !== id));
    setEditingSide(null);
  }

  return (
    <div className="screen-pad">
      <div className="side-summary-strip">
        <span><strong>{activeCount}</strong> actifs</span>
        <span><strong>{sides.length}</strong> au total</span>
        {cleanupCount > 0 && <span><strong>{cleanupCount}</strong> à nettoyer</span>}
      </div>
      <div className="search-bar">
        <Search size={16} style={{ alignSelf: "center", color: "var(--muted)" }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher un accompagnement…"
        />
      </div>
      <div className="filter-chips">
        {["favoris", "nettoyage", "inactifs"].map((f) => (
          <button
            key={f}
            className={`filter-chip${filters.has(f) ? " active" : ""}`}
            onClick={() => toggleFilter(f)}
          >
            {f === "favoris" ? "Fréquents" : f === "nettoyage" ? "À nettoyer" : "Désactivés"}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="empty-state"><RefreshCw size={24} className="spin" /></div>
      ) : (
        <div className="side-library-list">
          {visibleSides.length === 0 && (
            <div className="empty-state"><p>Aucun accompagnement trouvé</p></div>
          )}
          {visibleSides.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`side-library-row${s.is_active ? "" : " inactive"}`}
              onClick={() => setEditingSide(s)}
            >
              <div className="side-library-main">
                <div className="side-library-title-row">
                  <span className="side-library-name">{s.name}</span>
                  <SideStatusBadges side={s} />
                </div>
                <div className="side-library-meta">
                  <SideUsageMeta side={s} />
                </div>
              </div>
              <div className="side-library-actions">
                <Pencil size={15} aria-hidden="true" />
              </div>
            </button>
          ))}
        </div>
      )}
      <div className="sides-add" style={{ marginTop: 12 }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nouvel accompagnement…"
          onKeyDown={(e) => e.key === "Enter" && addSide()}
        />
        <button onClick={addSide}><Plus size={14} /></button>
      </div>
      {editingSide && (
        <SideEditorModal
          side={editingSide}
          onClose={() => setEditingSide(null)}
          onSave={(name) => renameSide(editingSide.id, name)}
          onToggleActive={() => toggleActive(editingSide)}
          onDelete={() => deleteSide(editingSide.id)}
        />
      )}
    </div>
  );
}

function SideStatusBadges({ side }: { side: SideStat }) {
  return (
    <span className="side-library-badges">
      {!side.is_active && <span className="badge badge-ago">Désactivé</span>}
      {side.is_favorite && <span className="badge badge-lunch">Fréquent</span>}
      {side.total_count === 0 && <span className="badge badge-score-warn">Jamais utilisé</span>}
    </span>
  );
}

function SideUsageMeta({ side }: { side: SideStat }) {
  if (side.total_count === 0) return null;
  return (
    <>
      <span>{side.total_count} utilisation{side.total_count > 1 ? "s" : ""}</span>
      {side.last_used && <span>{weeksAgo(side.last_used)}</span>}
    </>
  );
}

function SideEditorModal({
  side,
  onClose,
  onSave,
  onToggleActive,
  onDelete,
}: {
  side: SideStat;
  onClose: () => void;
  onSave: (name: string) => void;
  onToggleActive: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(side.name);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal side-editor-modal"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(name);
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <span className="modal-title" style={{ flex: 1 }}>Modifier l'accompagnement</span>
          <button className="btn-icon" type="button" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="edit-meal-section">
          <div className="section-label">Nom</div>
          <input
            className="side-editor-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="edit-meal-section">
          <div className="section-label">Utilisation</div>
          <div className="side-editor-stats">
            <div>
              <strong>{side.total_count}</strong>
              <span>utilisation{side.total_count > 1 ? "s" : ""}</span>
            </div>
            <div>
              <strong>{side.last_used ? weeksAgo(side.last_used) : "Jamais"}</strong>
              <span>dernière fois</span>
            </div>
            <div>
              <strong>{side.is_active ? "Actif" : "Désactivé"}</strong>
              <span>dans les choix</span>
            </div>
          </div>
        </div>
        <div className="modal-sticky-actions">
          <button className="btn btn-ghost btn-danger-ghost" type="button" onClick={onDelete}>
            <Trash2 size={14} /> Supprimer
          </button>
          <button className="btn btn-secondary" type="button" onClick={onToggleActive}>
            {side.is_active ? <EyeOff size={14} /> : <Eye size={14} />}
            {side.is_active ? "Désactiver" : "Activer"}
          </button>
          <button className="btn btn-secondary" type="button" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" type="submit" disabled={!name.trim() || name.trim() === side.name}>
            Enregistrer
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── RecipeDetailModal ────────────────────────────────────────────────────────

function CanonicalIngredientPicker({
  value,
  ingredients,
  fallbackLabel = "",
  placeholder = "Ingrédient Menu Hebdo",
  onSelect,
}: {
  value?: string | null;
  ingredients: CanonicalIngredient[];
  fallbackLabel?: string;
  placeholder?: string;
  onSelect: (ingredient: CanonicalIngredient) => void;
}) {
  const selected = ingredients.find((ingredient) => ingredient.id === value);
  const selectedLabel = selected?.name ?? fallbackLabel;
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const normalizedQuery = searchKey(query.trim());
  const filtered = normalizedQuery
    ? ingredients.filter((ingredient) => searchKey(ingredient.name).includes(normalizedQuery)).slice(0, 8)
    : ingredients.slice(0, 8);

  useEffect(() => {
    setQuery(selectedLabel);
  }, [selected?.id, selectedLabel]);

  function selectIngredient(ingredient: CanonicalIngredient) {
    onSelect(ingredient);
    setQuery(ingredient.name);
    setOpen(false);
  }

  function commitExactMatch() {
    const exact = ingredients.find((ingredient) => searchKey(ingredient.name) === normalizedQuery);
    if (exact) {
      selectIngredient(exact);
      return;
    }
    setQuery(selectedLabel);
    setOpen(false);
  }

  return (
    <div className="ingredient-picker">
      <input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={commitExactMatch}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            if (filtered[0]) selectIngredient(filtered[0]);
          }
          if (event.key === "Escape") {
            setQuery(selectedLabel);
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && (
        <div className="ingredient-picker-menu">
          {filtered.length > 0 ? (
            filtered.map((ingredient) => (
              <button
                key={ingredient.id}
                type="button"
                className={`ingredient-picker-option${ingredient.id === value ? " selected" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectIngredient(ingredient);
                }}
              >
                {ingredient.name}
              </button>
            ))
          ) : (
            <div className="ingredient-picker-empty">Aucun ingrédient existant</div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const [notes, setNotes] = useState(recipe.notes ?? "");
  const [tagIds, setTagIds] = useState<string[]>(recipe.tag_ids ?? []);
  const [allTags, setAllTags] = useState<CanonicalTag[]>([]);
  const [likedBy, setLikedBy] = useState<string[]>(recipe.liked_by ?? []);
  const [ingredients, setIngredients] = useState<Ingredient[]>(recipe.ingredients ?? []);
  const [allIngredients, setAllIngredients] = useState<CanonicalIngredient[]>([]);
  const [ingredientLinks, setIngredientLinks] = useState<IngredientInventoryLink[]>([]);
  const [inventoryProducts, setInventoryProducts] = useState<InventoryProduct[]>([]);
  const allChildren = usePeople();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (recipe.source !== "local") return;
    api<CanonicalTag[]>("/api/tags")
      .then((t) => setAllTags([...t].filter((tag) => !tag.is_filter).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => notify("Impossible de charger les catégories."));
    loadCanonicalIngredients()
      .then((t) => setAllIngredients([...t].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => notify("Impossible de charger les ingrédients canoniques."));
    loadIngredientLinks()
      .then(setIngredientLinks)
      .catch(() => undefined);
    loadInventoryProducts()
      .then(setInventoryProducts)
      .catch(() => undefined);
  }, [recipe.source]);

  function toggleLikedBy(childId: string) {
    setLikedBy((prev) => prev.includes(childId) ? prev.filter((c) => c !== childId) : [...prev, childId]);
  }

  function toggleTag(tagId: string) {
    setTagIds((prev) => prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]);
  }

  function updateIngredient(index: number, patch: Partial<Ingredient>) {
    setIngredients((prev) => prev.map((ing, i) => (i === index ? { ...ing, ...patch } : ing)));
  }

  function addIngredientRow() {
    setIngredients((prev) => [...prev, { name: "" }]);
  }

  function removeIngredientRow(index: number) {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
  }

  function selectIngredientRow(index: number, canonicalIngredient: CanonicalIngredient) {
    updateIngredient(index, {
      name: canonicalIngredient.name,
      unit: unitForCanonicalIngredient(canonicalIngredient.id, ingredientLinks, inventoryProducts),
      canonical_ingredient_id: canonicalIngredient.id,
    });
  }

  async function save() {
    setSaving(true);
    try {
      if (recipe.source === "mealie" && recipe.slug) {
        await api(`/api/recipes/mealie/${recipe.slug}/meta`, {
          method: "PATCH",
          body: JSON.stringify({
            is_weekend: isWeekend, makes_lunch: makesLunch, is_hidden: isHidden, notes, liked_by: likedBy,
          }),
        });
        onUpdated({ ...recipe, is_weekend: isWeekend, makes_lunch: makesLunch, is_hidden: isHidden, notes, liked_by: likedBy });
      } else if (recipe.source === "local" && recipe.id) {
        const updated = await api<Recipe>(`/api/local-recipes/${recipe.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(),
            prep_minutes: prep ? parseInt(prep) : null,
            is_weekend: isWeekend,
            makes_lunch: makesLunch,
            tag_ids: tagIds,
            notes,
            liked_by: likedBy,
            ingredients: normalizeLocalRecipeIngredients(ingredients, allIngredients, ingredientLinks, inventoryProducts),
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
      <div className="modal recipe-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="recipe-detail-header">
          <div className="recipe-detail-title-block">
            <h2>{recipe.source === "local" ? name : recipe.name}</h2>
            <div className="recipe-detail-meta">
              {(recipe.source === "local" ? prep : recipe.prep_minutes) && (
                <span className="badge badge-ago">{recipe.source === "local" ? prep : recipe.prep_minutes} min</span>
              )}
              {recipe.last_used && <span className="badge badge-ago">{weeksAgo(recipe.last_used)}</span>}
              {recipe.total_count ? <span className="badge badge-ago">{recipe.total_count}x</span> : null}
              {recipe.inventory_score?.score !== null && recipe.inventory_score?.score !== undefined && (
                <span className={`badge ${scoreClass(recipe.inventory_score.score)}`}>
                  {Math.round(recipe.inventory_score.score * 100)}% dispo
                </span>
              )}
            </div>
          </div>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>

        {recipe.inventory_score?.score !== null && recipe.inventory_score?.score !== undefined && (
          <section className="recipe-detail-section">
            <div className="section-label">Inventaire</div>
            {recipe.inventory_score.missing.length > 0 ? (
              <>
                <div className="recipe-last" style={{ marginBottom: 6 }}>Ingrédients manquants</div>
                <div className="detail-chip-row">
                  {recipe.inventory_score.missing.map((item) => (
                    <span key={item} className="detail-chip missing">{item}</span>
                  ))}
                </div>
              </>
            ) : (
              <div className="recipe-last">Tous les ingrédients détectés sont disponibles.</div>
            )}
          </section>
        )}

        {canEdit && recipe.source === "local" && (
          <section className="recipe-detail-section">
            <div className="section-label">Informations</div>
            <div className="detail-form-grid">
              <div className="form-row">
                <label>Nom</label>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="form-row">
                <label>Préparation (min)</label>
                <input type="number" value={prep} onChange={(e) => setPrep(e.target.value)} min="0" />
              </div>
            </div>
          </section>
        )}

        {canEdit && recipe.source === "local" && (
          <section className="recipe-detail-section">
            <div className="section-label">Ingrédients</div>
            {ingredients.map((ing, i) => (
              <div key={i} className="ingredient-row ingredient-row-picker">
                <input
                  type="number"
                  value={ing.quantity ?? ""}
                  onChange={(e) => updateIngredient(i, { quantity: e.target.value ? parseFloat(e.target.value) : null })}
                  placeholder="Qté"
                  min="0"
                  className="ingredient-quantity"
                />
                <CanonicalIngredientPicker
                  value={resolveCanonicalIngredient(ing, allIngredients)?.id ?? null}
                  ingredients={allIngredients}
                  fallbackLabel={ing.name}
                  onSelect={(canonicalIngredient) => selectIngredientRow(i, canonicalIngredient)}
                />
                <button className="btn-icon" onClick={() => removeIngredientRow(i)} title="Retirer">
                  <X size={13} />
                </button>
              </div>
            ))}
            <button className="btn btn-secondary" style={{ marginTop: 6 }} onClick={addIngredientRow}>
              <Plus size={13} /> Ajouter un ingrédient
            </button>
            {ingredients.length > 0 && !ingredients.some((i) => i.canonical_ingredient_id) && (
              <div className="recipe-last" style={{ marginTop: 6 }}>
                Reliez au moins un ingrédient Menu Hebdo pour activer le calcul de disponibilité.
              </div>
            )}
          </section>
        )}

        {canEdit && (
          <section className="recipe-detail-section">
            <div className="section-label">Préférences</div>
            <div className="detail-chip-row">
              <button
                type="button"
                className={`toggle-chip${isWeekend ? " active" : ""}`}
                onClick={() => setIsWeekend((v) => !v)}
              >
                Week-end
              </button>
              <button
                type="button"
                className={`toggle-chip${makesLunch ? " active" : ""}`}
                onClick={() => setMakesLunch((v) => !v)}
              >
                Lunchs
              </button>
              {recipe.source === "mealie" && (
                <button
                  type="button"
                  className={`toggle-chip danger${isHidden ? " active" : ""}`}
                  onClick={() => setIsHidden((v) => !v)}
                >
                  Masquée
                </button>
              )}
            </div>
            {allChildren.length > 0 && (
              <>
                <div className="recipe-last" style={{ margin: "12px 0 6px" }}>Aimé par</div>
                <div className="detail-chip-row">
                  {allChildren.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`person-chip${likedBy.includes(c.id) ? " active" : ""}`}
                      style={likedBy.includes(c.id) ? presenceTagStyle(c) : undefined}
                      onClick={() => toggleLikedBy(c.id)}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}

        <section className="recipe-detail-section">
          <div className="section-label">Catégories</div>
          {recipe.source === "local" && canEdit ? (
            allTags.length > 0 ? (
              <div className="detail-chip-row">
                {allTags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`tag-choice${tagIds.includes(t.id) ? " active" : ""}`}
                    style={tagIds.includes(t.id) ? {
                      background: t.color || DEFAULT_TAG_COLOR,
                      color: readableTextColor(t.color || DEFAULT_TAG_COLOR),
                    } : undefined}
                    onClick={() => toggleTag(t.id)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            ) : (
              <div className="recipe-last">Aucune catégorie configurée.</div>
            )
          ) : recipe.tags.length > 0 ? (
            <div className="detail-chip-row">
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
          ) : (
            <div className="recipe-last">Aucune catégorie.</div>
          )}
        </section>

        {canEdit && (
          <section className="recipe-detail-section">
            <div className="section-label">Notes</div>
            <textarea
              className="detail-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Notes familiales, ajustements, variantes..."
            />
          </section>
        )}

        {canEdit && (
          <div className="modal-sticky-actions">
            {recipe.source === "local" && (
              <button className="btn btn-ghost btn-danger-ghost" onClick={handleDelete}>
                <Trash2 size={14} /> Supprimer
              </button>
            )}
            <button className="btn btn-secondary" onClick={onClose}>Annuler</button>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={saving || (recipe.source === "local" && !name.trim())}
            >
              {saving ? "..." : "Enregistrer"}
            </button>
          </div>
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
  const [likedBy, setLikedBy] = useState<string[]>(recipe?.liked_by ?? []);
  const [ingredients, setIngredients] = useState<Ingredient[]>(recipe?.ingredients ?? []);
  const [allIngredients, setAllIngredients] = useState<CanonicalIngredient[]>([]);
  const [ingredientLinks, setIngredientLinks] = useState<IngredientInventoryLink[]>([]);
  const [inventoryProducts, setInventoryProducts] = useState<InventoryProduct[]>([]);
  const allChildren = usePeople();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<CanonicalTag[]>("/api/tags")
      .then((t) => setAllTags([...t].filter((tag) => !tag.is_filter).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => notify("Impossible de charger les catégories."));
    loadCanonicalIngredients()
      .then((t) => setAllIngredients([...t].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => notify("Impossible de charger les ingrédients canoniques."));
    loadIngredientLinks()
      .then(setIngredientLinks)
      .catch(() => undefined);
    loadInventoryProducts()
      .then(setInventoryProducts)
      .catch(() => undefined);
  }, []);

  function toggleLikedBy(childId: string) {
    setLikedBy((prev) => prev.includes(childId) ? prev.filter((c) => c !== childId) : [...prev, childId]);
  }

  function toggleTag(tagId: string) {
    setTagIds((prev) => prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]);
  }

  function updateIngredient(index: number, patch: Partial<Ingredient>) {
    setIngredients((prev) => prev.map((ing, i) => (i === index ? { ...ing, ...patch } : ing)));
  }

  function addIngredientRow() {
    setIngredients((prev) => [...prev, { name: "" }]);
  }

  function removeIngredientRow(index: number) {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
  }

  function selectIngredientRow(index: number, canonicalIngredient: CanonicalIngredient) {
    updateIngredient(index, {
      name: canonicalIngredient.name,
      unit: unitForCanonicalIngredient(canonicalIngredient.id, ingredientLinks, inventoryProducts),
      canonical_ingredient_id: canonicalIngredient.id,
    });
  }

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
        liked_by: likedBy,
        ingredients: normalizeLocalRecipeIngredients(ingredients, allIngredients, ingredientLinks, inventoryProducts),
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
          <label>Catégories</label>
          {allTags.length > 0 ? (
            <div className="detail-chip-row">
              {allTags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`tag-choice${tagIds.includes(t.id) ? " active" : ""}`}
                  style={tagIds.includes(t.id) ? {
                    background: t.color || DEFAULT_TAG_COLOR,
                    color: readableTextColor(t.color || DEFAULT_TAG_COLOR),
                  } : undefined}
                  onClick={() => toggleTag(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          ) : (
            <div className="recipe-last">Aucune catégorie configurée.</div>
          )}
        </div>
        {allChildren.length > 0 && (
          <div className="form-row">
            <label>Aimé par</label>
            <div className="filter-chips">
              {allChildren.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`filter-chip${likedBy.includes(c.id) ? " active" : ""}`}
                  onClick={() => toggleLikedBy(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="form-row">
          <label>Ingrédients</label>
          {ingredients.map((ing, i) => (
            <div key={i} className="ingredient-row ingredient-row-picker">
              <input
                type="number"
                value={ing.quantity ?? ""}
                onChange={(e) => updateIngredient(i, { quantity: e.target.value ? parseFloat(e.target.value) : null })}
                placeholder="Qté"
                min="0"
                className="ingredient-quantity"
              />
              <CanonicalIngredientPicker
                value={resolveCanonicalIngredient(ing, allIngredients)?.id ?? null}
                ingredients={allIngredients}
                fallbackLabel={ing.name}
                onSelect={(canonicalIngredient) => selectIngredientRow(i, canonicalIngredient)}
              />
              <button className="btn-icon" onClick={() => removeIngredientRow(i)} title="Retirer">
                <X size={13} />
              </button>
            </div>
          ))}
          <button className="btn btn-secondary" style={{ marginTop: 6 }} onClick={addIngredientRow}>
            <Plus size={13} /> Ajouter un ingrédient
          </button>
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
  const [tab, setTab] = useState<"meals" | "sides" | "associations" | "contexts">("meals");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<HistoryResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [freq, setFreq] = useState<FreqEntry[]>([]);
  const [sideFreq, setSideFreq] = useState<SideFreqEntry[]>([]);
  const [associations, setAssociations] = useState<MealSideAssociation[]>([]);
  const [associationRecipe, setAssociationRecipe] = useState("");
  const [associationSide, setAssociationSide] = useState("");
  const [contextStats, setContextStats] = useState<ContextStats | null>(null);
  const [freqWeeks, setFreqWeeks] = useState(12);

  useEffect(() => {
    loadStats(freqWeeks)
      .then((stats) => {
        setFreq(stats.freq);
        setSideFreq(stats.sideFreq);
        setAssociations(stats.associations);
        setContextStats(stats.contextStats);
      })
      .catch(() => notify("Impossible de charger les statistiques."));
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
  const maxSideCount = Math.max(...sideFreq.map((f) => f.count), 1);
  const associationRecipeOptions = Array.from(new Set(associations.map((a) => a.recipe_name)))
    .sort((a, b) => a.localeCompare(b));
  const associationSideOptions = Array.from(
    new Map(
      associations.map((a) => [
        associationSideKey(a),
        { key: associationSideKey(a), name: a.side_name },
      ]),
    ).values(),
  ).sort((a, b) => a.name.localeCompare(b.name));
  const selectedRecipeAssociations = associations
    .filter((a) => a.recipe_name === associationRecipe)
    .sort((a, b) => b.count - a.count || a.side_name.localeCompare(b.side_name));
  const selectedSideAssociations = associations
    .filter((a) => associationSideKey(a) === associationSide)
    .sort((a, b) => b.count - a.count || a.recipe_name.localeCompare(b.recipe_name));
  const maxRecipeSideCount = Math.max(...selectedRecipeAssociations.map((a) => a.count), 1);
  const maxSideRecipeCount = Math.max(...selectedSideAssociations.map((a) => a.count), 1);

  useEffect(() => {
    if (associationRecipeOptions.length === 0) {
      if (associationRecipe) setAssociationRecipe("");
      return;
    }
    if (!associationRecipeOptions.includes(associationRecipe)) {
      setAssociationRecipe(associationRecipeOptions[0]);
    }
  }, [associationRecipe, associationRecipeOptions]);

  useEffect(() => {
    if (associationSideOptions.length === 0) {
      if (associationSide) setAssociationSide("");
      return;
    }
    if (!associationSideOptions.some((option) => option.key === associationSide)) {
      setAssociationSide(associationSideOptions[0].key);
    }
  }, [associationSide, associationSideOptions]);

  return (
    <div className="screen-pad">
      <ul className="segmented stats-tabs">
        <li>
          <button className={tab === "meals" ? "active" : ""} onClick={() => setTab("meals")}>
            Repas
          </button>
        </li>
        <li>
          <button className={tab === "sides" ? "active" : ""} onClick={() => setTab("sides")}>
            Accompagnements
          </button>
        </li>
        <li>
          <button className={tab === "associations" ? "active" : ""} onClick={() => setTab("associations")}>
            Associations
          </button>
        </li>
        <li>
          <button className={tab === "contexts" ? "active" : ""} onClick={() => setTab("contexts")}>
            Sorties
          </button>
        </li>
      </ul>

      {tab === "meals" && (
        <>
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
            <StatsSectionHeader title="Fréquence des repas" weeks={freqWeeks} onWeeksChange={setFreqWeeks} />
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
                        <FrequencyBar count={f.count} maxCount={maxCount} />
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
        </>
      )}

      {tab === "sides" && (
        <div className="settings-section">
          <StatsSectionHeader title="Fréquence des accompagnements" weeks={freqWeeks} onWeeksChange={setFreqWeeks} />
          {sideFreq.length === 0 ? (
            <div className="empty-state"><p>Pas encore de données</p></div>
          ) : (
            <table className="freq-table">
              <thead>
                <tr>
                  <th>Accompagnement</th>
                  <th>Fréquence</th>
                  <th>Dernière fois</th>
                </tr>
              </thead>
              <tbody>
                {sideFreq.map((f) => (
                  <tr key={f.side_id ?? f.name}>
                    <td>{f.name}</td>
                    <td style={{ width: 120 }}>
                      <FrequencyBar count={f.count} maxCount={maxSideCount} />
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
      )}

      {tab === "associations" && (
        <div className="settings-section">
          <StatsSectionHeader title="Associations repas + accompagnements" weeks={freqWeeks} onWeeksChange={setFreqWeeks} />
          {associations.length === 0 ? (
            <div className="empty-state"><p>Pas encore d'associations à afficher</p></div>
          ) : (
            <div className="stats-association-grid">
              <div className="stats-association-panel">
                <label>
                  <span>Repas</span>
                  <select value={associationRecipe} onChange={(e) => setAssociationRecipe(e.target.value)}>
                    {associationRecipeOptions.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </label>
                {selectedRecipeAssociations.length === 0 ? (
                  <div className="recipe-last">Aucun accompagnement lié</div>
                ) : (
                  <table className="freq-table">
                    <thead>
                      <tr>
                        <th>Accompagnement</th>
                        <th>Fréquence</th>
                        <th>Dernière fois</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedRecipeAssociations.map((a) => (
                        <tr key={`${a.recipe_name}-${associationSideKey(a)}`}>
                          <td>{a.side_name}</td>
                          <td style={{ width: 120 }}>
                            <FrequencyBar count={a.count} maxCount={maxRecipeSideCount} />
                          </td>
                          <td style={{ fontSize: 12, color: "var(--muted)" }}>{weeksAgo(a.last_date)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="stats-association-panel">
                <label>
                  <span>Accompagnement</span>
                  <select value={associationSide} onChange={(e) => setAssociationSide(e.target.value)}>
                    {associationSideOptions.map((option) => (
                      <option key={option.key} value={option.key}>{option.name}</option>
                    ))}
                  </select>
                </label>
                {selectedSideAssociations.length === 0 ? (
                  <div className="recipe-last">Aucun repas lié</div>
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
                      {selectedSideAssociations.map((a) => (
                        <tr key={`${associationSideKey(a)}-${a.recipe_name}`}>
                          <td>{a.recipe_name}</td>
                          <td style={{ width: 120 }}>
                            <FrequencyBar count={a.count} maxCount={maxSideRecipeCount} />
                          </td>
                          <td style={{ fontSize: 12, color: "var(--muted)" }}>{weeksAgo(a.last_date)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "contexts" && (
        <div className="settings-section">
          <StatsSectionHeader title="Sorties et réceptions" weeks={freqWeeks} onWeeksChange={setFreqWeeks} />
          {contextStats && (
            <>
              <div className="stats-summary-grid">
                <div className="stats-summary-item">
                  <strong>{contextStats.summary.away ?? 0}</strong>
                  <span>chez proches/amis</span>
                </div>
                <div className="stats-summary-item">
                  <strong>{contextStats.summary.hosting ?? 0}</strong>
                  <span>réceptions</span>
                </div>
                <div className="stats-summary-item">
                  <strong>{contextStats.summary.restaurant ?? 0}</strong>
                  <span>restaurants</span>
                </div>
              </div>
              {[
                ["away", "Chez qui on mange"],
                ["hosting", "Qui on reçoit"],
                ["restaurant", "Restaurants"],
              ].map(([kind, title]) => {
                const rows = contextStats.by_kind[kind as keyof ContextStats["by_kind"]] ?? [];
                return (
                  <div key={kind} style={{ marginTop: 14 }}>
                    <div className="favorites-label">{title}</div>
                    {rows.length === 0 ? (
                      <div className="recipe-last">Pas encore de données</div>
                    ) : (
                      <table className="freq-table">
                        <tbody>
                          {rows.map((r) => (
                            <tr key={`${r.kind}-${r.context_id ?? r.name}`}>
                              <td>{r.name}</td>
                              <td style={{ width: 70 }}>{r.count}×</td>
                              <td style={{ fontSize: 12, color: "var(--muted)" }}>{weeksAgo(r.last_date)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StatsSectionHeader({
  title,
  weeks,
  onWeeksChange,
}: {
  title: string;
  weeks: number;
  onWeeksChange: (weeks: number) => void;
}) {
  return (
    <div className="stats-section-header">
      <h2>{title}</h2>
      <div className="filter-chips">
        {[4, 8, 12].map((w) => (
          <button
            key={w}
            className={`filter-chip${weeks === w ? " active" : ""}`}
            onClick={() => onWeeksChange(w)}
          >
            {w} sem.
          </button>
        ))}
      </div>
    </div>
  );
}

function FrequencyBar({ count, maxCount }: { count: number; maxCount: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div className="freq-bar" style={{ width: `${(count / maxCount) * 80}px` }} />
      <span style={{ fontSize: 12, color: "var(--muted)" }}>{count}×</span>
    </div>
  );
}

function associationSideKey(association: Pick<MealSideAssociation, "side_id" | "side_name">) {
  return association.side_id || `free:${association.side_name}`;
}

// ─── SettingsScreen ───────────────────────────────────────────────────────────

type SettingsTab = "general" | "meals" | "inventory" | "family" | "contexts" | "notifications";

const ADMIN_SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "Général" },
  { id: "meals", label: "Repas" },
  { id: "inventory", label: "Inventaire" },
  { id: "family", label: "Famille" },
  { id: "contexts", label: "Sorties" },
  { id: "notifications", label: "Notifications" },
];

const BASIC_SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "notifications", label: "Notifications" },
];

function SettingsScreen({ canAdmin }: { canAdmin: boolean }) {
  const [tab, setTab] = useState<SettingsTab>(() => (canAdmin ? "general" : "notifications"));
  const tabs = canAdmin ? ADMIN_SETTINGS_TABS : BASIC_SETTINGS_TABS;

  useEffect(() => {
    if (!tabs.some((item) => item.id === tab)) {
      setTab(tabs[0].id);
    }
  }, [tab, tabs]);

  return (
    <div className="screen-pad">
      <ul className="segmented settings-tabs">
        {tabs.map((item) => (
          <li key={item.id}>
            <button className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
              {item.label}
            </button>
          </li>
        ))}
      </ul>

      {canAdmin && tab === "general" && (
        <>
          <SyncSection />
        </>
      )}
      {canAdmin && tab === "meals" && (
        <>
          <TagMappingsSection />
          <CanonicalTagsSection />
        </>
      )}
      {canAdmin && tab === "family" && (
        <>
          <ChildColorsSection />
          <FamilyMembersSection />
        </>
      )}
      {canAdmin && tab === "inventory" && (
        <IngredientAssociationsSection />
      )}
      {canAdmin && tab === "contexts" && <MealContextsSection />}
      {tab === "notifications" && <NotificationsSection />}
    </div>
  );
}

function SyncSection() {
  const [syncing, setSyncing] = useState(false);

  async function syncNow() {
    setSyncing(true);
    try {
      const result = await api<{ recipes: number; presence_days: number }>("/api/sync/refresh", { method: "POST" });
      notify(`Synchronisé : ${result.recipes} recette(s) Mealie, présence sur ${result.presence_days} jour(s).`);
    } catch {
      notify("Échec de la synchronisation.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="settings-section">
      <div style={{ display: "flex", alignItems: "center" }}>
        <h2 style={{ flex: 1, margin: 0 }}>Synchronisation</h2>
        <button className="btn btn-secondary" onClick={syncNow} disabled={syncing}>
          <RefreshCw size={13} /> {syncing ? "…" : "Synchroniser maintenant"}
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 0" }}>
        Les recettes Mealie et la présence des enfants sont rafraîchies automatiquement toutes les 30 minutes.
        Utilise ce bouton pour forcer une mise à jour immédiate.
      </p>
    </div>
  );
}

function TagMappingsSection() {
  const [mappings, setMappings] = useState<TagMapping[]>([]);
  const [tags, setTags] = useState<CanonicalTag[]>([]);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    loadTagMappings().then(setMappings).catch(() => notify("Impossible de charger les mappings de tags."));
    loadCanonicalTags().then(setTags).catch(() => notify("Impossible de charger les tags."));
  }, []);

  async function confirm(mapping: TagMapping, canonicalId: string | undefined, status: string) {
    const updated = await api<TagMapping>(`/api/tag-mappings/${encodeURIComponent(mapping.mealie_tag_name)}`, {
      method: "PUT",
      body: JSON.stringify({ canonical_tag_id: canonicalId, status }),
    });
    setMappings((prev) => prev.map((m) => (m.mealie_tag_name === mapping.mealie_tag_name ? updated : m)));
    replaceTagMappingsCache((prev) => prev.map((m) => (m.mealie_tag_name === mapping.mealie_tag_name ? updated : m)));
    invalidateRecipeListCache();
  }

  async function syncTags() {
    setSyncing(true);
    try {
      await api("/api/tag-mappings/sync", { method: "POST" });
      tagMappingsCache = null;
      const updated = await loadTagMappings();
      setMappings(updated);
      invalidateRecipeListCache();
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
    loadCanonicalTags()
      .then(setTags)
      .catch(() => notify("Impossible de charger les tags."));
  }, []);

  async function addTag() {
    if (!newName.trim()) return;
    const t = await api<CanonicalTag>("/api/tags", {
      method: "POST",
      body: JSON.stringify({ name: newName.trim() }),
    });
    setTags((prev) => byName([...prev, t]));
    replaceCanonicalTagsCache((prev) => [...prev, t]);
    invalidateRecipeListCache();
    setNewName("");
  }

  async function renameTag(id: string, name: string) {
    if (!name.trim()) return;
    const t = await api<CanonicalTag>(`/api/tags/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim() }),
    });
    setTags((prev) => byName(prev.map((x) => (x.id === id ? t : x))));
    replaceCanonicalTagsCache((prev) => prev.map((x) => (x.id === id ? t : x)));
    invalidateRecipeListCache();
  }

  async function recolorTag(id: string, color: string) {
    const t = await api<CanonicalTag>(`/api/tags/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ color }),
    });
    setTags((prev) => prev.map((x) => (x.id === id ? t : x)));
    replaceCanonicalTagsCache((prev) => prev.map((x) => (x.id === id ? t : x)));
    invalidateRecipeListCache();
  }

  async function toggleTagFilter(id: string, isFilter: boolean) {
    const t = await api<CanonicalTag>(`/api/tags/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_filter: isFilter }),
    });
    setTags((prev) => prev.map((x) => (x.id === id ? t : x)));
    replaceCanonicalTagsCache((prev) => prev.map((x) => (x.id === id ? t : x)));
    invalidateRecipeListCache();
  }

  async function deleteTag(id: string) {
    await api(`/api/tags/${id}`, { method: "DELETE" });
    setTags((prev) => prev.filter((t) => t.id !== id));
    replaceCanonicalTagsCache((prev) => prev.filter((t) => t.id !== id));
    invalidateRecipeListCache();
  }

  return (
    <div className="settings-section">
      <h2>Catégories de recettes</h2>
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
          placeholder="Nouvelle catégorie…"
          onKeyDown={(e) => e.key === "Enter" && addTag()}
        />
        <button onClick={addTag}><Plus size={14} /></button>
      </div>
    </div>
  );
}

function enrichIngredientMapping(mapping: IngredientMapping, ingredients: CanonicalIngredient[]): IngredientMapping {
  if (mapping.status !== "confirmed" || !mapping.canonical_ingredient_id) return mapping;
  return {
    ...mapping,
    canonical_ingredient_name:
      mapping.canonical_ingredient_name ??
      ingredients.find((ingredient) => ingredient.id === mapping.canonical_ingredient_id)?.name,
  };
}

function IngredientAssociationsSection() {
  const [ingredients, setIngredients] = useState<CanonicalIngredient[]>([]);
  const [mappings, setMappings] = useState<IngredientMapping[]>([]);
  const [links, setLinks] = useState<IngredientInventoryLink[]>([]);
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [newName, setNewName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [centerQuery, setCenterQuery] = useState("");
  const [mealieQuery, setMealieQuery] = useState("");
  const [inventoryQuery, setInventoryQuery] = useState("");
  const [editingIngredientId, setEditingIngredientId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [ignoredMealieOpen, setIgnoredMealieOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [syncingMealie, setSyncingMealie] = useState(false);
  const [syncingInventory, setSyncingInventory] = useState(false);

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [loadedIngredients, loadedMappings, loadedLinks, loadedProducts] = await Promise.all([
        loadCanonicalIngredients(),
        loadIngredientMappings(),
        loadIngredientLinks(),
        loadInventoryProducts(),
      ]);
      setIngredients(loadedIngredients);
      setMappings(loadedMappings.map((mapping) => enrichIngredientMapping(mapping, loadedIngredients)));
      setLinks(loadedLinks);
      setProducts(loadedProducts);
    } catch {
      notify("Impossible de charger les associations d'ingrédients.");
    } finally {
      setLoading(false);
    }
  }

  function selectedIngredientName() {
    return ingredients.find((ingredient) => ingredient.id === selectedId)?.name ?? "Vue globale";
  }

  async function addIngredient() {
    if (!newName.trim()) return;
    const ing = await api<CanonicalIngredient>("/api/canonical-ingredients", {
      method: "POST",
      body: JSON.stringify({ name: newName.trim() }),
    });
    setIngredients((prev) => byName([...prev, ing]));
    replaceCanonicalIngredientsCache((prev) => [...prev, ing]);
    invalidateRecipeListCache();
    setSelectedId(ing.id);
    setNewName("");
  }

  async function renameIngredient(id: string, name: string) {
    if (!name.trim()) return;
    const ing = await api<CanonicalIngredient>(`/api/canonical-ingredients/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim() }),
    });
    setIngredients((prev) => byName(prev.map((x) => (x.id === id ? ing : x))));
    setMappings((prev) => prev.map((mapping) => enrichIngredientMapping(mapping, ingredients.map((x) => (x.id === id ? ing : x)))));
    replaceCanonicalIngredientsCache((prev) => prev.map((x) => (x.id === id ? ing : x)));
    invalidateRecipeListCache();
    setEditingIngredientId(null);
    setRenameDraft("");
  }

  async function deleteIngredient(id: string) {
    await api(`/api/canonical-ingredients/${id}`, { method: "DELETE" });
    setIngredients((prev) => prev.filter((x) => x.id !== id));
    setLinks((prev) => prev.filter((l) => l.canonical_ingredient_id !== id));
    setMappings((prev) => prev.map((mapping) => (
      mapping.canonical_ingredient_id === id
        ? { ...mapping, canonical_ingredient_id: undefined, canonical_ingredient_name: undefined, status: "pending" }
        : mapping
    )));
    replaceCanonicalIngredientsCache((prev) => prev.filter((x) => x.id !== id));
    replaceIngredientLinksCache((prev) => prev.filter((l) => l.canonical_ingredient_id !== id));
    invalidateRecipeListCache();
    setSelectedId((current) => current === id ? null : current);
    setEditingIngredientId(null);
  }

  function startRenameIngredient(ingredient: CanonicalIngredient) {
    setEditingIngredientId(ingredient.id);
    setRenameDraft(ingredient.name);
  }

  async function confirmDeleteIngredient(ingredient: CanonicalIngredient) {
    if (!confirm(`Supprimer "${ingredient.name}" ? Les associations liées seront retirées.`)) return;
    await deleteIngredient(ingredient.id);
  }

  async function addLink(canonicalIngredientId: string, product: InventoryProduct) {
    const link = await api<IngredientInventoryLink>("/api/ingredient-inventory-links", {
      method: "POST",
      body: JSON.stringify({
        canonical_ingredient_id: canonicalIngredientId,
        inventory_product_id: product.product_id,
        inventory_product_name: product.name,
        domain: product.domain,
      }),
    });
    setLinks((prev) => [
      ...prev.filter((l) => l.id !== link.id && l.inventory_product_id !== link.inventory_product_id),
      { ...link, is_live: true },
    ]);
    replaceIngredientLinksCache((prev) => [
      ...prev.filter((l) => l.id !== link.id && l.inventory_product_id !== link.inventory_product_id),
      { ...link, is_live: true },
    ]);
    invalidateRecipeListCache();
  }

  async function removeLink(linkId: string) {
    await api(`/api/ingredient-inventory-links/${linkId}`, { method: "DELETE" });
    setLinks((prev) => prev.filter((l) => l.id !== linkId));
    replaceIngredientLinksCache((prev) => prev.filter((l) => l.id !== linkId));
    invalidateRecipeListCache();
  }

  async function updateMapping(mapping: IngredientMapping, canonicalId: string | undefined, status: IngredientMapping["status"]) {
    const updated = await api<IngredientMapping>(`/api/ingredient-mappings/${encodeURIComponent(mapping.mealie_ingredient_text)}`, {
      method: "PUT",
      body: JSON.stringify({ canonical_ingredient_id: canonicalId, status }),
    });
    const enriched = enrichIngredientMapping(updated, ingredients);
    setMappings((prev) => prev.map((m) => (m.mealie_ingredient_text === mapping.mealie_ingredient_text ? enriched : m)));
    replaceIngredientMappingsCache((prev) => prev.map((m) => (m.mealie_ingredient_text === mapping.mealie_ingredient_text ? enriched : m)));
    invalidateRecipeListCache();
  }

  async function syncMealieIngredients() {
    setSyncingMealie(true);
    try {
      const result = await api<{ imported: number }>("/api/ingredient-mappings/sync", { method: "POST" });
      ingredientMappingsCache = null;
      const updated = await loadIngredientMappings();
      setMappings(updated.map((mapping) => enrichIngredientMapping(mapping, ingredients)));
      invalidateRecipeListCache();
      notify(`${result.imported} ingrédient(s) Mealie synchronisé(s).`, "info");
    } catch {
      notify("Impossible de synchroniser les ingrédients Mealie.");
    } finally {
      setSyncingMealie(false);
    }
  }

  async function syncInventoryProducts() {
    setSyncingInventory(true);
    try {
      const refreshedProducts = await refreshInventoryProducts();
      ingredientLinksCache = null;
      const refreshedLinks = await loadIngredientLinks();
      setProducts(refreshedProducts);
      setLinks(refreshedLinks);
      notify(`${refreshedProducts.length} item(s) d'inventaire synchronisé(s).`, "info");
    } catch {
      notify("Impossible de synchroniser l'inventaire.");
    } finally {
      setSyncingInventory(false);
    }
  }

  const selected = ingredients.find((ingredient) => ingredient.id === selectedId) ?? null;
  const ingredientById = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const linkByProductId = new Map<string, IngredientInventoryLink>();
  for (const link of links) linkByProductId.set(link.inventory_product_id, link);
  const productById = new Map<string, InventoryProduct>();
  for (const product of products) {
    productById.set(product.product_id, product);
    for (const sourceId of product.source_product_ids ?? []) {
      productById.set(sourceId, product);
    }
  }
  function linkForProduct(product: InventoryProduct): IngredientInventoryLink | undefined {
    return [product.product_id, ...(product.source_product_ids ?? [])]
      .map((id) => linkByProductId.get(id))
      .find(Boolean);
  }
  function logicalLinkId(link: IngredientInventoryLink): string {
    return productById.get(link.inventory_product_id)?.product_id ?? link.inventory_product_id;
  }
  function logicalInventoryCount(canonicalIngredientId: string): number {
    return new Set(
      links
        .filter((link) => link.canonical_ingredient_id === canonicalIngredientId)
        .map(logicalLinkId)
    ).size;
  }
  const selectedMealieCount = selectedId
    ? mappings.filter((mapping) => mapping.canonical_ingredient_id === selectedId && mapping.status === "confirmed").length
    : mappings.filter((mapping) => mapping.status === "confirmed").length;
  const selectedInventoryCount = selectedId ? logicalInventoryCount(selectedId) : 0;
  const filteredIngredients = ingredients.filter((ingredient) => searchKey(ingredient.name).includes(searchKey(centerQuery)));
  const selectedMappings = mappings
    .filter((mapping) => mapping.status === "confirmed" && (!selectedId || mapping.canonical_ingredient_id === selectedId))
    .filter((mapping) => searchKey(mapping.mealie_ingredient_text).includes(searchKey(mealieQuery)));
  const pendingMappings = mappings
    .filter((mapping) => mapping.status === "pending")
    .filter((mapping) => searchKey(mapping.mealie_ingredient_text).includes(searchKey(mealieQuery)));
  const otherMappings = mappings
    .filter((mapping) => selectedId && mapping.status === "confirmed" && mapping.canonical_ingredient_id !== selectedId)
    .filter((mapping) => searchKey(mapping.mealie_ingredient_text).includes(searchKey(mealieQuery)));
  const ignoredMappings = mappings
    .filter((mapping) => mapping.status === "ignored")
    .filter((mapping) => searchKey(mapping.mealie_ingredient_text).includes(searchKey(mealieQuery)));
  const selectedLinks = [
    ...new Map(
      links
        .filter((link) => !selectedId || link.canonical_ingredient_id === selectedId)
        .map((link) => [logicalLinkId(link), link])
    ).values(),
  ];
  const filteredProducts = products.filter((product) => searchKey(product.name).includes(searchKey(inventoryQuery)));
  const availableProducts = filteredProducts.filter((product) => (
    selectedId
      ? linkForProduct(product)?.canonical_ingredient_id !== selectedId
      : !linkForProduct(product)
  ));
  const linkedProductCount = new Set(links.map(logicalLinkId)).size;

  function renderMappingRow(mapping: IngredientMapping, mode: "selected" | "pending" | "other" | "ignored") {
    const targetName = mapping.canonical_ingredient_name ?? (
      mapping.canonical_ingredient_id ? ingredientById.get(mapping.canonical_ingredient_id)?.name : undefined
    );
    return (
      <div key={mapping.mealie_ingredient_text} className={`association-row association-row-${mode}`}>
        <span className={`status-dot ${mapping.status}`} />
        <div className="association-row-main">
          <span className="association-row-title">{mapping.mealie_ingredient_text}</span>
          {targetName && <span className="association-row-subtitle">vers {targetName}</span>}
          {mode === "ignored" && <span className="association-row-subtitle">ignoré durablement</span>}
        </div>
        {selected && mode !== "selected" && (
          <button
            className="btn btn-secondary btn-xs"
            type="button"
            onClick={() => updateMapping(mapping, selected.id, "confirmed")}
          >
            Associer
          </button>
        )}
        {mode !== "ignored" && (
          <button
            className="btn-icon"
            type="button"
            onClick={() => updateMapping(mapping, undefined, "ignored")}
            title="Ignorer durablement"
          >
            <EyeOff size={13} />
          </button>
        )}
        {selected && mode === "selected" && (
          <button
            className="btn-icon"
            type="button"
            onClick={() => updateMapping(mapping, undefined, "pending")}
            title="Retirer l'association"
          >
            <X size={13} />
          </button>
        )}
        {mode === "ignored" && (
          <button
            className="btn btn-secondary btn-xs"
            type="button"
            onClick={() => updateMapping(mapping, undefined, "pending")}
          >
            Restaurer
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="settings-section ingredient-associations">
      <div className="settings-section-header">
        <div>
          <h2>Associations ingrédients</h2>
          <p>Relie les ingrédients Mealie et les items d'inventaire autour des ingrédients Menu Hebdo.</p>
        </div>
        <div className="association-sync-actions">
          <button className="btn btn-secondary" type="button" onClick={syncMealieIngredients} disabled={syncingMealie}>
            <RefreshCw size={13} /> {syncingMealie ? "…" : "Sync Mealie"}
          </button>
          <button className="btn btn-secondary" type="button" onClick={syncInventoryProducts} disabled={syncingInventory}>
            <RefreshCw size={13} /> {syncingInventory ? "…" : "Sync inventaire"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state"><RefreshCw size={24} className="spin" /></div>
      ) : (
        <div className="association-board">
          <section className="association-column">
            <div className="association-column-header">
              <h3>Mealie</h3>
              <span>{mappings.filter((mapping) => mapping.status === "pending").length} à traiter</span>
            </div>
            <div className="association-search">
              <Search size={14} />
              <input value={mealieQuery} onChange={(e) => setMealieQuery(e.target.value)} placeholder="Rechercher Mealie…" />
            </div>
            <AssociationGroup title={selected ? `Associés à ${selectedIngredientName()}` : "Associés"} count={selectedMappings.length}>
              {selectedMappings.map((mapping) => renderMappingRow(mapping, "selected"))}
            </AssociationGroup>
            <AssociationGroup title="Non associés" count={pendingMappings.length}>
              {pendingMappings.map((mapping) => renderMappingRow(mapping, "pending"))}
            </AssociationGroup>
            {selected && (
              <AssociationGroup title="Associés ailleurs" count={otherMappings.length}>
                {otherMappings.map((mapping) => renderMappingRow(mapping, "other"))}
              </AssociationGroup>
            )}
            <AssociationGroup
              title="Ignorés"
              count={ignoredMappings.length}
              collapsed={!ignoredMealieOpen}
              onToggle={() => setIgnoredMealieOpen((open) => !open)}
            >
              {ignoredMappings.map((mapping) => renderMappingRow(mapping, "ignored"))}
            </AssociationGroup>
          </section>

          <section className="association-column association-column-center">
            <div className="association-column-header">
              <h3>Ingrédients Menu Hebdo</h3>
              <span>{ingredients.length}</span>
            </div>
            <div className="association-search">
              <Search size={14} />
              <input value={centerQuery} onChange={(e) => setCenterQuery(e.target.value)} placeholder="Rechercher…" />
            </div>
            <div className="association-list association-list-center">
              <button
                type="button"
                className={`ingredient-pivot-row ingredient-pivot-row-global${selectedId === null ? " active" : ""}`}
                onClick={() => {
                  setSelectedId(null);
                  setEditingIngredientId(null);
                }}
              >
                <span className="ingredient-pivot-name">Vue globale</span>
                <span className="ingredient-pivot-counts">
                  {mappings.filter((mapping) => mapping.status === "pending").length} Mealie à traiter · {products.length - linkedProductCount} inventaire non associé
                </span>
              </button>
              {filteredIngredients.map((ingredient) => {
                const mealieCount = mappings.filter((mapping) => mapping.status === "confirmed" && mapping.canonical_ingredient_id === ingredient.id).length;
                const inventoryCount = logicalInventoryCount(ingredient.id);
                return (
                  <button
                    key={ingredient.id}
                    type="button"
                    className={`ingredient-pivot-row${ingredient.id === selectedId ? " active" : ""}`}
                    onClick={() => setSelectedId(ingredient.id)}
                  >
                    <span className="ingredient-pivot-name">{ingredient.name}</span>
                    <span className="ingredient-pivot-counts">
                      {mealieCount} Mealie · {inventoryCount} inventaire
                    </span>
                  </button>
                );
              })}
              {filteredIngredients.length === 0 && <div className="association-empty">Aucun ingrédient</div>}
            </div>
            <div className="association-create-row">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Nouvel ingrédient Menu Hebdo…"
                onKeyDown={(e) => e.key === "Enter" && addIngredient()}
              />
              <button className="btn-icon" type="button" onClick={addIngredient} title="Créer">
                <Plus size={14} />
              </button>
            </div>
            {selected && (
              <div className="association-selected-editor">
                <label>Ingrédient sélectionné</label>
                {editingIngredientId === selected.id ? (
                  <div className="association-edit-row">
                    <input
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") renameIngredient(selected.id, renameDraft);
                        if (e.key === "Escape") {
                          setEditingIngredientId(null);
                          setRenameDraft("");
                        }
                      }}
                      autoFocus
                    />
                    <button className="btn btn-primary btn-xs" type="button" onClick={() => renameIngredient(selected.id, renameDraft)}>
                      Enregistrer
                    </button>
                    <button className="btn btn-secondary btn-xs" type="button" onClick={() => setEditingIngredientId(null)}>
                      Annuler
                    </button>
                  </div>
                ) : (
                  <div className="association-selected-card">
                    <div className="association-selected-main">
                      <strong>{selected.name}</strong>
                      <span>{selectedMealieCount} Mealie · {selectedInventoryCount} inventaire</span>
                    </div>
                    <button className="btn btn-secondary btn-xs" type="button" onClick={() => startRenameIngredient(selected)}>
                      <Pencil size={12} /> Renommer
                    </button>
                    <button className="btn btn-ghost btn-xs btn-danger-inline" type="button" onClick={() => confirmDeleteIngredient(selected)}>
                      <Trash2 size={12} /> Supprimer
                    </button>
                  </div>
                )}
                <div className="association-selected-stats">
                  <span>{selectedMealieCount} ingrédient(s) Mealie</span>
                  <span>{selectedInventoryCount} item(s) inventaire</span>
                </div>
              </div>
            )}
            {!selected && (
              <div className="association-selected-editor association-global-summary">
                <label>Vue globale</label>
                <div className="association-selected-stats">
                  <span>{mappings.filter((mapping) => mapping.status === "pending").length} ingrédient(s) Mealie à traiter</span>
                  <span>{mappings.filter((mapping) => mapping.status === "ignored").length} ignoré(s)</span>
                  <span>{products.length - linkedProductCount} item(s) inventaire non associé(s)</span>
                </div>
              </div>
            )}
          </section>

          <section className="association-column">
            <div className="association-column-header">
              <h3>Inventaire familial</h3>
              <span>{products.length} items</span>
            </div>
            <div className="association-search">
              <Search size={14} />
              <input value={inventoryQuery} onChange={(e) => setInventoryQuery(e.target.value)} placeholder="Rechercher inventaire…" />
            </div>
            <AssociationGroup title={selected ? `Associés à ${selectedIngredientName()}` : "Associés"} count={selectedLinks.length}>
              {selectedLinks.map((link) => (
                (() => {
                  const product = productById.get(link.inventory_product_id);
                  return (
                    <div key={link.id} className={`association-row${link.is_live ? "" : " association-row-missing"}`}>
                      <span className={`status-dot ${link.is_live ? "confirmed" : "ignored"}`} />
	                      <div className="association-row-main">
	                        <span className="association-row-title">{link.inventory_product_name}</span>
	                        {product ? (
	                          <InventoryQuantityLines product={product} />
	                        ) : (
	                          <span className="association-row-subtitle">introuvable dans l'inventaire actuel</span>
	                        )}
	                      </div>
                      <button className="btn-icon" type="button" onClick={() => removeLink(link.id)} title="Retirer l'association">
                        <X size={13} />
                      </button>
                    </div>
                  );
                })()
              ))}
            </AssociationGroup>
            <AssociationGroup title="Items disponibles" count={availableProducts.length}>
              {availableProducts.map((product) => {
                const existingLink = linkForProduct(product);
                const linkedElsewhere = existingLink
                  ? ingredientById.get(existingLink.canonical_ingredient_id)?.name
                  : "";
                return (
                  <div key={product.product_id} className="association-row">
                    <span className="status-dot pending" />
	                    <div className="association-row-main">
	                      <span className="association-row-title">{product.name}</span>
	                      <InventoryQuantityLines product={product} linkedElsewhere={linkedElsewhere} />
	                    </div>
                    {selected && (
                      <button className="btn btn-secondary btn-xs" type="button" onClick={() => addLink(selected.id, product)}>
                        Associer
                      </button>
                    )}
                  </div>
                );
              })}
            </AssociationGroup>
          </section>
        </div>
      )}
    </div>
  );
}

function AssociationGroup({
  title,
  count,
  children,
  collapsed = false,
  onToggle,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="association-group">
      <div
        className={`association-group-title${onToggle ? " association-group-title-toggle" : ""}`}
        onClick={onToggle}
        role={onToggle ? "button" : undefined}
        tabIndex={onToggle ? 0 : undefined}
        onKeyDown={(e) => {
          if (!onToggle) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span>{title}</span>
        <span>{onToggle ? `${collapsed ? "Afficher" : "Masquer"} · ${count}` : count}</span>
      </div>
      {!collapsed && (
        <div className="association-list">
          {count > 0 ? children : <div className="association-empty">Rien ici</div>}
        </div>
      )}
    </div>
  );
}

function InventoryQuantityLines({ product, linkedElsewhere }: { product: InventoryProduct; linkedElsewhere?: string }) {
  const format = inventoryProductFormatLabel(product);
  return (
    <>
      <span className="association-row-quantity">{inventoryProductAvailableLabel(product)} disponibles</span>
      {format && <span className="association-row-subtitle">{format}</span>}
      {linkedElsewhere && <span className="association-row-subtitle">lié à {linkedElsewhere}</span>}
    </>
  );
}

function ChildColorsSection() {
  const [children, setChildren] = useState<Child[]>([]);

  useEffect(() => {
    loadChildren().then(setChildren).catch(() => notify("Impossible de charger les enfants."));
  }, []);

  async function recolor(id: string, color: string) {
    await api(`/api/children/${id}`, { method: "PATCH", body: JSON.stringify({ color }) });
    setChildren((prev) => prev.map((c) => (c.id === id ? { ...c, color } : c)));
    replaceChildrenCache((prev) => prev.map((c) => (c.id === id ? { ...c, color } : c)));
  }

  if (children.length === 0) return null;

  return (
    <div className="settings-section">
      <h2>Couleurs de présence</h2>
      <div className="canonical-tags-list">
        {children.map((c) => (
          <div key={c.id} className="canonical-tag-row">
            <input
              type="color"
              value={c.color || DEFAULT_TAG_COLOR}
              onChange={(e) => recolor(c.id, e.target.value)}
              title="Couleur du tag de présence dans Semaine et Repas"
              className="tag-color-input"
            />
            <span style={{ flex: 1, fontSize: 14 }}>{c.name} ({c.short_label})</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FamilyMembersSection() {
  const [members, setMembers] = useState<Child[]>([]);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    loadFamilyMembers().then(setMembers).catch(() => notify("Impossible de charger les membres de la famille."));
  }, []);

  async function addMember() {
    if (!newName.trim()) return;
    const m = await api<Child>("/api/family-members", {
      method: "POST",
      body: JSON.stringify({ name: newName.trim() }),
    });
    setMembers((prev) => byName([...prev, m]));
    replaceFamilyMembersCache((prev) => [...prev, m]);
    invalidateRecipeListCache();
    setNewName("");
  }

  async function rename(id: string, name: string) {
    if (!name.trim()) return;
    const m = await api<Child>(`/api/family-members/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim() }),
    });
    setMembers((prev) => byName(prev.map((x) => (x.id === id ? m : x))));
    replaceFamilyMembersCache((prev) => prev.map((x) => (x.id === id ? m : x)));
    invalidateRecipeListCache();
  }

  async function recolor(id: string, color: string) {
    await api(`/api/family-members/${id}`, { method: "PATCH", body: JSON.stringify({ color }) });
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, color } : m)));
    replaceFamilyMembersCache((prev) => prev.map((m) => (m.id === id ? { ...m, color } : m)));
    invalidateRecipeListCache();
  }

  async function deleteMember(id: string) {
    await api(`/api/family-members/${id}`, { method: "DELETE" });
    setMembers((prev) => prev.filter((m) => m.id !== id));
    replaceFamilyMembersCache((prev) => prev.filter((m) => m.id !== id));
    invalidateRecipeListCache();
  }

  return (
    <div className="settings-section">
      <h2>Autres membres de la famille</h2>
      <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
        Pour les préférences de repas de personnes hors calendrier familial (parents, etc.).
      </p>
      <div className="canonical-tags-list" style={{ marginBottom: 8 }}>
        {members.map((m) => (
          <div key={m.id} className="canonical-tag-row">
            <input
              type="color"
              value={m.color || DEFAULT_TAG_COLOR}
              onChange={(e) => recolor(m.id, e.target.value)}
              title="Couleur du tag dans Repas"
              className="tag-color-input"
            />
            <input
              defaultValue={m.name}
              key={m.id + m.name}
              onBlur={(e) => e.target.value !== m.name && rename(m.id, e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="tag-name-input"
            />
            <button className="btn-icon" onClick={() => deleteMember(m.id)} title="Supprimer">
              <X size={13} />
            </button>
          </div>
        ))}
        {members.length === 0 && (
          <div className="empty-state"><p>Aucun membre ajouté</p></div>
        )}
      </div>
      <div className="sides-add">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nom…"
          onKeyDown={(e) => e.key === "Enter" && addMember()}
        />
        <button onClick={addMember}><Plus size={14} /></button>
      </div>
    </div>
  );
}

function MealContextsSection() {
  const [contexts, setContexts] = useState<MealContext[]>([]);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<MealContext["kind"]>("people");

  function load() {
    loadMealContexts()
      .then(setContexts)
      .catch(() => notify("Impossible de charger les lieux et restaurants."));
  }

  useEffect(load, []);

  async function addContext() {
    if (!newName.trim()) return;
    const c = await api<MealContext>("/api/meal-contexts", {
      method: "POST",
      body: JSON.stringify({ kind: newKind, name: newName.trim() }),
    });
    setContexts((prev) => byName([...prev, c]));
    replaceMealContextsCache((prev) => [...prev, c]);
    setNewName("");
  }

  async function patchContext(id: string, payload: Partial<MealContext>) {
    const c = await api<MealContext>(`/api/meal-contexts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    setContexts((prev) => byName(prev.map((x) => (x.id === id ? c : x))));
    replaceMealContextsCache((prev) => prev.map((x) => (x.id === id ? c : x)));
  }

  async function deleteContext(id: string) {
    await api(`/api/meal-contexts/${id}`, { method: "DELETE" });
    setContexts((prev) => prev.map((c) => (c.id === id ? { ...c, is_active: false } : c)));
    replaceMealContextsCache((prev) => prev.map((c) => (c.id === id ? { ...c, is_active: false } : c)));
  }

  const groups: [MealContext["kind"], string][] = [
    ["people", "Personnes ou foyers"],
    ["restaurant", "Restaurants"],
  ];

  return (
    <div className="settings-section">
      <h2>Sorties, réceptions et restaurants</h2>
      <div className="context-add-row">
        <select value={newKind} onChange={(e) => setNewKind(e.target.value as MealContext["kind"])}>
          <option value="people">Personne/foyer</option>
          <option value="restaurant">Restaurant</option>
        </select>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Nom…"
          onKeyDown={(e) => e.key === "Enter" && addContext()}
        />
        <button onClick={addContext}><Plus size={14} /></button>
      </div>
      {groups.map(([kind, title]) => {
        const rows = contexts.filter((c) => c.kind === kind);
        return (
          <div key={kind} style={{ marginTop: 12 }}>
            <div className="favorites-label">{title}</div>
            <div className="context-list">
              {rows.length === 0 && <div className="recipe-last">Aucune entrée</div>}
              {rows.map((c) => (
                <div key={c.id} className={`context-row${c.is_active ? "" : " inactive"}`}>
                  <button
                    className="btn-icon"
                    onClick={() => patchContext(c.id, { is_active: !c.is_active })}
                    title={c.is_active ? "Désactiver" : "Activer"}
                  >
                    {c.is_active ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                  <div className="context-main">
                    <input
                      defaultValue={c.name}
                      key={`${c.id}-${c.name}`}
                      className="tag-name-input"
                      onBlur={(e) => e.target.value !== c.name && patchContext(c.id, { name: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                  </div>
                  <button className="btn-icon" onClick={() => deleteContext(c.id)} title="Désactiver">
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NotificationsSection() {
  const [enabled, setEnabled] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [vapidKey, setVapidKey] = useState("");

  useEffect(() => {
    loadNotificationConfig()
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
      .catch(() => {
        setLoading(false);
        notify("Impossible de charger la configuration des notifications.");
      });
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
