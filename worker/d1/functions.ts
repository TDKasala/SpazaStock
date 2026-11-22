/** Every shared-database RPC the Worker serves from D1, by its Postgres function name. */
import type { D1Like } from '../db/d1';
import type { D1Ctx } from './common';
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
};

/** Functions callable without a session (granted to the anon role in Postgres). */
export const ANON_FUNCTIONS = new Set(['preview_shop_invite']);
