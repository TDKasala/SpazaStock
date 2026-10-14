# SpazaStock - Step 1: Project Bootstrap

SpazaStock is a clean, mobile-first Progressive Web App (PWA) tailored specifically for spaza shop owners in South Africa, providing fast inventory recording, point-of-sale scanning, expiry monitoring, and stock visibility on Android mobile devices.

---

## 🛠 Tech Stack

- **Framework**: React 19 + TypeScript + Vite 8
- **Styling**: Tailwind CSS v4 (dark OLED-optimized theme, touch-friendly min 48px tap targets)
- **Database & Auth**: `@supabase/supabase-js` (safe client initialization with environment validation)
- **PWA**: `vite-plugin-pwa` with web app manifest, offline indicator, and in-app install prompt (`usePWAInstall`)
- **Localization**: Native English (default) & isiZulu (`en` / `zu`) dictionaries with instant language toggle
- **Icons**: `lucide-react`
- **Testing**: Vitest unit test suite

---

## 📱 Features Implemented

### Step 1: Project Bootstrap
- **Dashboard ("Your shop at a glance")**: 2x2 grid (Add Stock, Quick Sale, Expiry Alerts, View Stock).
- **Minimal Design System (`src/components/ui/`)**: Buttons, Inputs, Dialogs, Loading states, Error banners, and Action tiles.
- **Bilingual Localization (`src/locales/`)**: English (default) and authentic isiZulu translation dictionaries.
- **PWA Foundation**: Web App Manifest, splash/home-screen icons, in-app install prompt, and offline indicator.
- **Environment Validation & Safe Supabase Client**: Diagnostic validator, setup guide modal, and placeholder `.env.example`.

### Step 3: Barcode Scanner & Product Registration
- **Camera-Based Barcode Scanner (`BarcodeScannerModal`)**:
  - Powered by `html5-qrcode` configured for Android mobile browsers (rear-facing `facingMode: "environment"`).
  - Handles camera permission denials with clear instructions and 1-tap manual entry fallback.
  - Handles unsupported browsers and lack of media devices gracefully.
  - Live animated laser targeting reticle and hardware flashlight toggle.
  - Tactile vibration confirmation upon successful barcode detection (`navigator.vibrate`).
- **Manual Barcode Entry Fallback**:
  - Numeric/text input with keyboard autofill and quick validation.
  - Interactive test sample barcode chips (Albany Bread, Coca-Cola, Simba Chips, Sunlight) for fast desktop/mobile testing without a physical package.
- **Product Search in Active Shop**:
  - Immediately searches the shop catalog upon scan/entry with a loading overlay.
- **Product Found Display (`ProductFoundDialog`)**:
  - Displays product name, barcode, category, buying price (cost), selling price, and estimated profit markup.
  - Explicit reminder that stock batch quantities and expiry dates are managed separately in batch logging.
- **Product Registration Form (`ProductRegisterDialog`)**:
  - Opens automatically when an unknown barcode is detected.
  - Form fields: Barcode (prefilled & normalized), Product Name (required), Category, and Optional Buying/Selling Prices in ZAR (Rands).
  - **Duplicate Prevention**: Strictly prevents duplicate products with the same barcode in the active shop, displaying clear error messaging.
### Step 4: Quick Stock-In and Expiry Tracking
- **Stock-In Delivery Workflow (`QuickStockInModal`)**:
  - Scan barcode or select product to receive delivery batches.
  - **Additive Inventory**: Increases total available stock additively without overwriting prior inventory.
  - **Distinct Delivery Batches**: Each delivery is saved as a discrete batch (`StockBatch`) preserving individual expiry dates and quantities.
  - **Transactional Movements**: Creates immutable audit records (`StockMovement`) tracking quantity delta and resulting available balance.
  - **Touch-Friendly Controls**: Numeric stepper with quick increments (`+1`, `+5`, `+10`, `+24` crate presets), direct keypad typing.
  - **Batch Expiry Presets**: Perishable toggle, quick presets (`+5d Bread`, `+10d Milk`, `+1mo`, `+3mo`, `+6mo`), and ISO date picker.
  - **Instant Feedback**: Displays arithmetic breakdown (`Previous + Added = New Available Quantity`).
  - **Validation & Duplicate Protection**:
    - Validates positive integer quantities (`> 0` and integer).
    - Validates standard date formatting (`YYYY-MM-DD`).
    - Validates shop authorization/permissions.
    - Idempotency key tracking rejects duplicate delivery submissions.
- **Batch Inspection (`ProductStockDetailDialog`)**:
  - Detailed modal view displaying all active batches, units per batch, and days remaining until expiry.
- **Live Expiry Alerts Tab (`AlertsView`)**:
  - Categorizes batches into Critical/Urgent (`< 7 days`), Warning (`< 30 days`), and Expired batches.
### Step 5: Scan-to-Sell
- **Rapid Scan-to-Sell Register (`SalesRegister`)**:
  - Scanning a barcode deducts 1 unit immediately, updating available stock with instant tactile/visual feedback.
  - Repeated scans of the same barcode deduct additional units (+1 unit per scan) for fast counter checkout.
  - In-line / modal quantity adjustment allows selling multiple units at once (e.g. 5 loaves of bread).
- **Atomic Stock Operations & FEFO Batch Allocation**:
  - Automatically deducts inventory from the appropriate available batch, prioritizing the earliest expiring batch first (FEFO: First-Expired-First-Out).
  - Multi-batch fulfillment seamlessly splits deductions across batches when necessary.
  - Strictly prevents overselling and negative stock (`Insufficient stock: Only X units available`).
  - Mutex concurrency locks prevent race conditions during rapid concurrent sales.
  - Idempotency key protection rejects duplicate scans.
- **Offline Operation Queue**:
  - When disconnected, sales transactions are safely processed locally and queued in `offlineQueue` with pending status.
  - Offline sync banner allows shopkeepers to trigger a remote sync once internet connectivity is restored.
- **Bilingual Support**: Full English and isiZulu localization for register mode, receipts, and offline status.

---

## 🚀 Exact Commands to Run Locally

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy the template to your local environment file:
```bash
cp .env.example .env.local
```
Edit `.env.local` with your actual Supabase credentials:
```env
VITE_SUPABASE_URL="https://your-project-ref.supabase.co"
VITE_SUPABASE_ANON_KEY="your-anon-public-key"
```

### 3. Start Development Server
```bash
npm run dev
```
The app will run at `http://localhost:3000`.

### 4. Run Lint / Type-Check
```bash
npm run lint
```

### 5. Run Tests
```bash
npm run test
```

### 6. Build for Production
```bash
npm run build
```

---

## 📂 Created Project Files

- `src/types/index.ts`: Core TypeScript definitions.
- `src/lib/env.ts`: Environment variable validator and diagnostics.
- `src/lib/supabase.ts`: Safe Supabase client initialization.
- `src/locales/en.ts`: English translation dictionary.
- `src/locales/zu.ts`: isiZulu translation dictionary.
- `src/context/LanguageContext.tsx`: React language context provider and `useLanguage` hook.
- `src/hooks/usePWAInstall.ts`: PWA install prompt handler.
- `src/components/ui/Button.tsx`: Reusable Button component.
- `src/components/ui/Input.tsx`: Reusable Input component.
- `src/components/ui/Dialog.tsx`: Modal dialog component.
- `src/components/ui/LoadingState.tsx`: Spinner and Skeleton loading states.
- `src/components/ui/ErrorMessage.tsx`: Reusable alert message component.
- `src/components/ui/ActionTile.tsx`: 2x2 shop glance action card.
- `src/components/ui/Card.tsx`: Reusable container card.
- `src/components/pwa/PWAInstallButton.tsx`: PWA install button with iOS guide.
- `src/components/pwa/OfflineIndicator.tsx`: Connection status banner.
- `src/components/layout/Header.tsx`: Top header with branding, language switcher, and status pill.
- `src/components/layout/BottomNav.tsx`: Bottom navigation bar.
- `src/components/dashboard/Dashboard.tsx`: Main dashboard with the 4 action tiles.
- `src/components/setup/SetupGuideDialog.tsx`: Supabase connection modal.
- `src/components/views/StockView.tsx`: Stock inventory view foundation.
- `src/components/views/SalesView.tsx`: Point of sale view foundation.
- `src/components/views/AlertsView.tsx`: Freshness and expiry alerts view foundation.
- `src/test/env.test.ts`: Environment validation tests.
- `src/test/i18n.test.ts`: Localization dictionary symmetry tests.
- `public/manifest.webmanifest`: Web app manifest.
- `public/icon.svg`: Vector branding icon.
- `public/pwa-192x192.png`: 192px PWA icon.
- `public/pwa-512x512.png`: 512px PWA icon.
- `public/pwa-maskable-512x512.png`: 512px maskable PWA icon.
- `public/apple-touch-icon.png`: iOS touch icon.
- `.prettierrc`: Code formatting rules.
- `README.md`: Setup and architecture documentation.
