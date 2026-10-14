import { describe, it, expect } from 'vitest';
import { en } from '../locales/en';
import { zu } from '../locales/zu';

describe('Localization & Translation Dictionaries', () => {
  it('has identical top-level sections in English and isiZulu dictionaries', () => {
    const enKeys = Object.keys(en).sort();
    const zuKeys = Object.keys(zu).sort();
    expect(enKeys).toEqual(zuKeys);
  });

  it('contains translations for the 4 core dashboard actions in both languages', () => {
    expect(en.dashboard.actions.addStock.title).toBe('Add Stock');
    expect(en.dashboard.actions.quickSale.title).toBe('Quick Sale');
    expect(en.dashboard.actions.expiryAlerts.title).toBe('Expiry Alerts');
    expect(en.dashboard.actions.viewStock.title).toBe('View Stock');

    expect(zu.dashboard.actions.addStock.title).toBe('Faka Impahla');
    expect(zu.dashboard.actions.quickSale.title).toBe('Thengisa Masinyane');
    expect(zu.dashboard.actions.expiryAlerts.title).toBe('Izexwayiso Zokuphelelwa Isikhathi');
    expect(zu.dashboard.actions.viewStock.title).toBe('Buka Impahla');
  });

  it('matches heading text for your shop at a glance', () => {
    expect(en.dashboard.glanceHeading).toBe('Your shop at a glance');
    expect(zu.dashboard.glanceHeading).toBe('Isitolo sakho ngokushesha');
  });

  it('contains matching scanner and camera permission keys', () => {
    expect(en.scanner.title).toBe('Barcode Scanner');
    expect(zu.scanner.title).toBe('Iskena Samabhakhodi');
    expect(en.scanner.permissionDenied).toBeDefined();
    expect(zu.scanner.permissionDenied).toBeDefined();
    expect(en.scanner.unsupported).toBeDefined();
    expect(zu.scanner.unsupported).toBeDefined();
    expect(en.scanner.manualTab).toBe('Manual Entry');
    expect(zu.scanner.manualTab).toBe('Faka Ngesandla');
  });

  it('contains matching product registration and duplicate error keys', () => {
    expect(en.product.registerProduct).toBe('Register New Product');
    expect(zu.product.registerProduct).toBe('Bhalisa Umkhiqizo Omusha');
    expect(en.product.duplicateError).toBe('A product with this barcode already exists in your shop.');
    expect(zu.product.duplicateError).toBe('Umkhiqizo onaleli bhakhodi usuvele ukhona esitolo sakho.');
    expect(Object.keys(en.product.categories)).toEqual(Object.keys(zu.product.categories));
  });

  it('contains matching stockIn and expiry keys', () => {
    expect(en.stockIn.title).toBe('Stock-In Delivery');
    expect(zu.stockIn.title).toBe('Ukufaka Impahla Efikile');
    expect(en.stockIn.saveStockIn).toBeDefined();
    expect(zu.stockIn.saveStockIn).toBeDefined();
    expect(en.stockIn.newTotalStock).toBeDefined();
    expect(zu.stockIn.newTotalStock).toBeDefined();

    expect(en.expiry.alertsTitle).toBe('Expiry Alerts');
    expect(zu.expiry.alertsTitle).toBe('Izexwayiso Zokuphelelwa Isikhathi');
    expect(en.expiry.urgentExpiring).toBeDefined();
    expect(zu.expiry.urgentExpiring).toBeDefined();
    expect(en.expiry.expired).toBeDefined();
    expect(zu.expiry.expired).toBeDefined();
  });

  it('contains matching sales keys', () => {
    expect(en.sales.title).toBe('Scan-to-Sell');
    expect(zu.sales.title).toBe('Skena Uthengise');
    expect(en.sales.scanToSell).toBeDefined();
    expect(zu.sales.scanToSell).toBeDefined();
    expect(en.sales.unitsRemaining).toBeDefined();
    expect(zu.sales.unitsRemaining).toBeDefined();
    expect(en.sales.insufficientStock).toBeDefined();
    expect(zu.sales.insufficientStock).toBeDefined();
  });
});
