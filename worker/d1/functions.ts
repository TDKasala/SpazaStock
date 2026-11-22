/** Every shared-database RPC the Worker serves from D1, by its Postgres function name. */
import type { D1Like } from '../db/d1';
import type { D1Ctx } from './common';
import * as admin from './admin';
import * as catalog from './catalog';
import * as push from './push';
import * as team from './team';

export type D1Function = (db: D1Like, ctx: D1Ctx, args: Record<string, unknown>) => Promise<unknown>;

export const D1_FUNCTIONS: Record<string, D1Function> = {
  create_shop: team.createShop,
  my_shops: team.myShops,
  update_shop_alert_settings: team.updateShopAlertSettings,
  invite_shop_member: team.inviteShopMember,
  preview_shop_invite: team.previewShopInvite,
  accept_shop_invite: team.acceptShopInvite,
  resend_shop_invite: team.resendShopInvite,
  remove_shop_member: team.removeShopMember,
  set_member_status: team.setMemberStatus,
  update_member_role: team.updateMemberRole,
  list_shop_team: team.listShopTeam,
  save_push_subscription: push.savePushSubscription,
  delete_push_subscription: push.deletePushSubscription,
  report_sync_failures: push.reportSyncFailures,
  // These also read the shop's Durable Object, through CatalogCtx.shop.
  search_catalog: catalog.searchCatalog as D1Function,
  list_common_catalog: catalog.listCommonCatalog as D1Function,
  link_catalog_barcode: catalog.linkCatalogBarcode as D1Function,
  set_catalog_image: catalog.setCatalogImage as D1Function,
  list_shop_catalog_review: catalog.listShopCatalogReview as D1Function,
  submit_catalog_product: catalog.submitCatalogProduct as D1Function,
  submit_catalog_correction: catalog.submitCatalogCorrection as D1Function,
  // Platform administration (AdminCtx: needs ctx.shops for ledger figures).
  admin_whoami: admin.adminWhoami as unknown as D1Function,
  admin_list_tenants: admin.adminListTenants as unknown as D1Function,
  admin_export_tenants: admin.adminExportTenants as unknown as D1Function,
  admin_get_tenant: admin.adminGetTenant as unknown as D1Function,
  admin_create_shop: admin.adminCreateShop as unknown as D1Function,
  admin_set_shop_status: admin.adminSetShopStatus as unknown as D1Function,
  admin_update_subscription: admin.adminUpdateSubscription as unknown as D1Function,
  admin_list_admins: admin.adminListAdmins as unknown as D1Function,
  admin_grant_admin: admin.adminGrantAdmin as unknown as D1Function,
  admin_revoke_admin: admin.adminRevokeAdmin as unknown as D1Function,
  admin_set_admin_role: admin.adminSetAdminRole as unknown as D1Function,
  admin_list_audit: admin.adminListAudit as unknown as D1Function,
  admin_list_plans: admin.adminListPlans as unknown as D1Function,
  admin_upsert_plan: admin.adminUpsertPlan as unknown as D1Function,
  admin_set_entitlement: admin.adminSetEntitlement as unknown as D1Function,
  admin_set_feature: admin.adminSetFeature as unknown as D1Function,
  admin_platform_overview: admin.adminPlatformOverview as unknown as D1Function,
  admin_analytics: admin.adminAnalytics as unknown as D1Function,
  admin_growth_series: admin.adminGrowthSeries as unknown as D1Function,
  admin_operations_health: admin.adminOperationsHealth as unknown as D1Function,
  admin_search_catalog: admin.adminSearchCatalog as unknown as D1Function,
  admin_get_catalog_product: admin.adminGetCatalogProduct as unknown as D1Function,
  admin_save_catalog_product: admin.adminSaveCatalogProduct as unknown as D1Function,
  admin_link_catalog_barcode: admin.adminLinkCatalogBarcode as unknown as D1Function,
  admin_unlink_catalog_barcode: admin.adminUnlinkCatalogBarcode as unknown as D1Function,
  admin_set_catalog_common: admin.adminSetCatalogCommon as unknown as D1Function,
  admin_set_catalog_image: admin.adminSetCatalogImage as unknown as D1Function,
};

/** Functions callable without a session (granted to the anon role in Postgres). */
export const ANON_FUNCTIONS = new Set(['preview_shop_invite']);
