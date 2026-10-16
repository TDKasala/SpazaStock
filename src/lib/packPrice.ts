function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export interface PackSaleCharge {
  /** What the customer pays for this quantity. */
  total: number;
  /** Average price per base unit, so a sale line still stores one unit price. */
  unitPrice: number;
}

/**
 * Whole packs are charged at the pack price. Leftover units use the product's unit price.
 * A pack with no price charges every unit at the unit price.
 */
export function packSaleCharge(
  quantity: number,
  unitPrice: number,
  packaging: { unitsPerPackage: number; sellingPrice?: number | null } | null | undefined
): PackSaleCharge {
  const unit = roundMoney(Number.isFinite(unitPrice) ? unitPrice : 0);
  const count = Number.isInteger(quantity) && quantity > 0 ? quantity : 0;
  const packPrice = packaging?.sellingPrice;
  if (
    !packaging ||
    packPrice == null ||
    !Number.isFinite(packPrice) ||
    packaging.unitsPerPackage < 2 ||
    count === 0
  ) {
    return { total: roundMoney(unit * count), unitPrice: unit };
  }
  const packs = Math.floor(count / packaging.unitsPerPackage);
  const leftover = count % packaging.unitsPerPackage;
  const total = roundMoney(packs * roundMoney(packPrice) + leftover * unit);
  return { total, unitPrice: roundMoney(total / count) };
}
