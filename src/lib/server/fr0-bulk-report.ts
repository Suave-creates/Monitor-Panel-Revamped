// src/lib/server/fr0-bulk-report.ts
//
// Server-side business logic for the FR0 Bulk Report tab — a 1:1 clone of
// the CL Report's pipeline (Synced -> Pending Picking -> In Picking ->
// Order QC -> Packing -> Manifest, plus "Shipment Not Generated"; Ready To
// Ship intentionally not tracked), scoped to the bulk eyewear categories:
//
//   FR0  — frTag "FR0",  itemType ["FRAME","SUNGLASS","ACCESSORIES"]
//   BULK — frTag "BULK", itemType ["FRAME","SUNGLASS","ACCESSORIES"]
//
// Row grouping, JIT detection and the request-body shape are shared with
// cl-report.ts. As with CL Report's Bulk side, the upstream itemType
// request filter isn't honored for frTag=BULK, so groupOrders() re-filters
// each response row on its own "Item Type" field (see DEPTS[*].itemType).

import { pickingPriorityFor, type OrderCategory, type Priority } from "./delay-dashboard";
import {
  applyJitFilter,
  groupOrders,
  STAGE_META,
  type DateRange,
  type GroupedOrder,
  type International,
  type OrderItem,
  type RawRow,
  type StageKey,
} from "./cl-report";

export { applyJitFilter, groupOrders, STAGE_META };
export type { DateRange, GroupedOrder, International, OrderItem, Priority, RawRow, StageKey };

export type DeptKey = "FR0" | "BULK";

export type DeptConfig = { label: string; frTag: string; itemType: string[]; stages: StageKey[] };

const CORE_STAGES: StageKey[] = ["SYNCED", "PENDING_PICKING", "IN_PICKING", "ORDER_QC", "PACKING", "MANIFEST", "SHIPMENT_NOT_GENERATED"];

const ITEM_TYPES = ["FRAME", "SUNGLASS", "ACCESSORIES"];

export const DEPTS: Record<DeptKey, DeptConfig> = {
  FR0: { label: "FR0", frTag: "FR0", itemType: ITEM_TYPES, stages: CORE_STAGES },
  BULK: { label: "Bulk", frTag: "BULK", itemType: ITEM_TYPES, stages: CORE_STAGES },
};
export const DEPT_ORDER: DeptKey[] = ["FR0", "BULK"];
export const STAGE_ORDER: StageKey[] = CORE_STAGES;

export function buildMonitoringBody(
  deptKey: DeptKey,
  stageKey: StageKey,
  opts: { page: number; priority: Priority; dateRange?: DateRange; pageSize?: number; international?: International; category?: OrderCategory },
): RawRow {
  const dept = DEPTS[deptKey];
  const { page, priority, dateRange, pageSize = 500, international = "all", category = "FULFILLABLE_ORDERS" } = opts;
  const binaryFilter: RawRow = {};
  if (international === "intl") binaryFilter.isInternationalOrder = true;
  else if (international === "nonintl") binaryFilter.isInternationalOrder = false;
  return {
    page,
    pageSize,
    globalSearch: "",
    category,
    status: STAGE_META[stageKey].apiStatus,
    frTag: dept.frTag,
    version: "v3",
    monitorPanelFilters: {
      binaryFilter,
      singleSelectFilters: { errorType: "" },
      monitorPanelRangeFilters: {
        ageingSinceCreated: { startValue: 0, endValue: "-1" },
        ageingSinceLastUpdate: { startValue: 0, endValue: "-1" },
        date: dateRange || { startValue: "", endValue: "" },
      },
      multiSelectFilters: {
        pickingPriority: pickingPriorityFor(priority),
        qcStatus: [],
        itemType: dept.itemType,
        orderChannel: [],
      },
    },
  };
}
