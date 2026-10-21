import type { CatalogIntakeDraft, IntakeItemDraft, IntakeStep } from '../lib/catalogIntake';
import { db } from '../lib/db';

function draftKey(shopId: string): string {
  return `catalogIntake:${shopId}`;
}

function isStep(value: unknown): value is IntakeStep {
  return value === 'select' || value === 'count' || value === 'review';
}

function isDraft(value: unknown): value is CatalogIntakeDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as CatalogIntakeDraft;
  return isStep(draft.step) && Number.isInteger(draft.countIndex) && Array.isArray(draft.items);
}

export async function loadCatalogIntakeDraft(shopId: string): Promise<CatalogIntakeDraft | null> {
  const row = await db.meta.get(draftKey(shopId));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveCatalogIntakeDraft(shopId: string, draft: CatalogIntakeDraft): Promise<void> {
  await db.meta.put({ key: draftKey(shopId), value: JSON.stringify(draft) });
}

export async function replaceCatalogIntakeItems(shopId: string, items: IntakeItemDraft[]): Promise<void> {
  const current = await loadCatalogIntakeDraft(shopId);
  await saveCatalogIntakeDraft(shopId, {
    step: items.length === 0 ? 'select' : (current?.step ?? 'select'),
    countIndex: 0,
    items,
  });
}
