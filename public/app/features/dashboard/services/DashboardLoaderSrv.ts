import { AppEvents, dateMath, type UrlQueryMap, type UrlQueryValue } from '@grafana/data';
import { config, getBackendSrv, isFetchError, locationService } from '@grafana/runtime';
import { type Spec as DashboardV2Spec } from '@grafana/schema/apis/dashboard.grafana.app/v2';
import { backendSrv } from 'app/core/services/backend_srv';
import impressionSrv from 'app/core/services/impression_srv';
import { isRecord } from 'app/core/utils/isRecord';
import { getDashboardScenePageStateManager } from 'app/features/dashboard-scene/pages/DashboardScenePageStateManager';
import { getDatasourceSrv } from 'app/features/plugins/datasource_srv';
import { type DashboardDataDTO, type DashboardDTO } from 'app/types/dashboard';

import { appEvents } from '../../../core/app_events';
import { ResponseTransformers } from '../api/ResponseTransformers';
import { getDashboardAPI } from '../api/dashboard_api';
import { DashboardVersionError, type DashboardWithAccessInfo } from '../api/types';

import { getDashboardSrv } from './DashboardSrv';
import { getDashboardSnapshotSrv } from './SnapshotSrv';

type ScriptedDashboardExecution = { data: DashboardDataDTO };

export const SCRIPTED_DASHBOARDS_DEPRECATION_URL =
  'https://grafana.com/whats-new/2026-08-12-scripted-dashboards-will-be-removed-in-grafana-14/';
export const SCRIPTED_DASHBOARDS_DISABLED_MESSAGE_ID = 'scripted-dashboards-disabled';

// Scripted dashboards are arbitrary user code, so nothing has validated what they return.
// Accept any object and let the rest of the loading pipeline deal with the details.
function isDashboardData(value: unknown): value is DashboardDataDTO {
  return typeof value === 'object' && value !== null;
}

// Mirrors isDashboardV2() in pkg/services/publicdashboards/internal/service/query.go.
// apiVersion isn't guaranteed to be a bare version like "v2beta1" -- some backend
// code paths populate it as a full "group/version" string instead, so this checks
// the suffix after the last '/' rather than doing an exact/enum match.
function isStoredVersionV2(apiVersion: string | undefined): boolean {
  if (!apiVersion) {
    return false;
  }
  const version = apiVersion.includes('/') ? apiVersion.slice(apiVersion.lastIndexOf('/') + 1) : apiVersion;
  return version !== '' && !version.startsWith('v0') && !version.startsWith('v1');
}

interface DashboardLoaderSrvLike<T> {
  loadDashboard(
    type: UrlQueryValue,
    slug: string | undefined,
    uid: string | undefined,
    params?: UrlQueryMap
  ): Promise<T>;
}

abstract class DashboardLoaderSrvBase<T> implements DashboardLoaderSrvLike<T> {
  abstract loadDashboard(
    type: UrlQueryValue,
    slug: string | undefined,
    uid: string | undefined,
    params?: UrlQueryMap
  ): Promise<T>;

  abstract loadSnapshot(slug: string): Promise<T>;

  protected loadScriptedDashboard(file: string): Promise<DashboardDTO> {
    if (config.featureToggles.disableScriptedDashboards) {
      return Promise.reject({
        status: 410,
        messageId: SCRIPTED_DASHBOARDS_DISABLED_MESSAGE_ID,
        message:
          'Scripted dashboards are deprecated and have been disabled. They will be removed in Grafana 14. ' +
          'To temporarily restore them, set the "disableScriptedDashboards" feature toggle to false.',
      });
    }

    const url = 'public/dashboards/' + file.replace(/\.(?!js)/, '/') + '?' + new Date().getTime();

    return getBackendSrv()
      .get(url, undefined, undefined, { validatePath: true })
      .then(this.executeScript.bind(this))
      .then(
        (result) => {
          return {
            meta: {
              fromScript: true,
              canDelete: false,
              canSave: false,
              canStar: false,
            },
            dashboard: result.data,
          };
        },
        (err) => {
          console.error('Script dashboard error ' + err);
          appEvents.emit(AppEvents.alertError, [
            'Script Error',
            'Please make sure it exists and returns a valid dashboard',
          ]);
          throw err;
        }
      );
  }

  private async executeScript(result: string): Promise<ScriptedDashboardExecution> {
    // Async-load dependencies used only in scripted dashboards to avoid them being in the main bundle, if not needed
    const [{ default: jQuery }, { default: moment }, { default: lodash }, { default: kbn }] = await Promise.all([
      import('jquery'),
      import('moment'),
      import('lodash'),
      import('app/core/utils/kbn'),
    ]);

    const services = {
      dashboardSrv: getDashboardSrv(),
      datasourceSrv: getDatasourceSrv(),
    };
    const scriptFunc = new Function(
      'ARGS',
      'kbn',
      'dateMath',
      '_',
      'moment',
      'window',
      'document',
      '$',
      'jQuery',
      'services',
      result
    );
    const scriptResult: unknown = scriptFunc(
      locationService.getSearchObject(),
      kbn,
      dateMath,
      lodash,
      moment,
      window,
      document,
      jQuery,
      jQuery,
      services
    );

    // Handle async dashboard scripts
    if (typeof scriptResult === 'function') {
      return new Promise((resolve, reject) => {
        scriptResult((dashboard: unknown) => {
          if (!isDashboardData(dashboard)) {
            reject(new Error('Scripted dashboard did not return a dashboard'));
            return;
          }

          resolve({ data: dashboard });
        });
      });
    }

    if (!isDashboardData(scriptResult)) {
      throw new Error('Scripted dashboard did not return a dashboard');
    }

    return { data: scriptResult };
  }
}

export class DashboardLoaderSrv extends DashboardLoaderSrvBase<DashboardDTO> {
  loadDashboard(
    type: UrlQueryValue,
    slug: string | undefined,
    uid: string | undefined,
    params?: UrlQueryMap
  ): Promise<DashboardDTO> {
    const stateManager = getDashboardScenePageStateManager('v1');
    let promise;

    if (type === 'script' && slug) {
      promise = this.loadScriptedDashboard(slug);
    } else if (type === 'snapshot' && slug) {
      promise = getDashboardSnapshotSrv().getSnapshot(slug);
    } else if (type === 'public' && uid) {
      promise = backendSrv.getPublicDashboardByUid(uid).then((result) => {
        // Public dashboards don't go through the k8s resource /dto subresource
        // (that's where the uid branch below gets its version-mismatch signal
        // from), so the version check has to happen here instead, against the
        // apiVersion the public dashboards backend now reports in meta.
        if (isStoredVersionV2(result.meta?.apiVersion)) {
          throw new DashboardVersionError(result.meta?.apiVersion, 'Public dashboard is V2 format');
        }
        return result;
      });
    } else if (uid) {
      if (!params) {
        const cachedDashboard = stateManager.getDashboardFromCache(uid);
        if (cachedDashboard) {
          return Promise.resolve(cachedDashboard);
        }
      }

      promise = getDashboardAPI('v1').then(async (api) => {
        try {
          return await api.getDashboardDTO(uid, params);
        } catch (e) {
          if (isFetchError(e) && !(e instanceof DashboardVersionError)) {
            console.error('Failed to load dashboard', e);
            e.isHandled = true;
            if (e.status === 404) {
              appEvents.emit(AppEvents.alertError, ['Dashboard not found']);
            }
          }

          throw e;
        }
      });
    } else {
      throw new Error('Dashboard uid or slug required');
    }

    promise.then((result: DashboardDTO) => {
      impressionSrv.addDashboardImpression(result.dashboard.uid);

      return result;
    });

    return promise;
  }

  loadSnapshot(slug: string): Promise<DashboardDTO> {
    const promise = getDashboardSnapshotSrv().getSnapshot(slug);

    promise.then((result: DashboardDTO) => {
      impressionSrv.addDashboardImpression(result.dashboard.uid);

      return result;
    });

    return promise;
  }
}

export class DashboardLoaderSrvV2 extends DashboardLoaderSrvBase<DashboardWithAccessInfo<DashboardV2Spec>> {
  loadDashboard(
    type: UrlQueryValue,
    slug: string | undefined,
    uid: string | undefined,
    params?: UrlQueryMap
  ): Promise<DashboardWithAccessInfo<DashboardV2Spec>> {
    const stateManager = getDashboardScenePageStateManager('v2');
    let promise;

    if (type === 'script' && slug) {
      promise = this.loadScriptedDashboard(slug).then((r) => ResponseTransformers.ensureV2Response(r));
    } else if (type === 'public' && uid) {
      promise = backendSrv.getPublicDashboardByUid(uid).then((result) => {
        // ensureV2Response() only recognizes a v2 payload when the *top-level*
        // object has kind/apiVersion (the DashboardWithAccessInfo/Dashboard
        // resource shape). A public dashboard response nests the real payload
        // one level down, in `result.dashboard`, so a v2 `result.dashboard`
        // still looks like a plain, kind-less object to ensureV2Response and
        // gets misread as a v1 DashboardDataDTO -- silently producing an
        // empty/broken spec instead of an error, since a v1-shaped object and
        // an unrecognized object look identical to that function.
        //
        // If the nested payload already carries its own kind/apiVersion,
        // construct the DashboardWithAccessInfo<DashboardV2Spec> shape
        // directly from it instead of routing it through the v1->v2 upward
        // conversion pipeline.
        const rawDashboard = result.dashboard;
        if (
          isRecord(rawDashboard) &&
          rawDashboard.kind === 'Dashboard' &&
          typeof rawDashboard.apiVersion === 'string' &&
          isStoredVersionV2(rawDashboard.apiVersion) &&
          isRecord(rawDashboard.metadata) &&
          isRecord(rawDashboard.spec)
        ) {
          const dashboardWithAccessInfo: DashboardWithAccessInfo<DashboardV2Spec> = {
            kind: 'DashboardWithAccessInfo',
            apiVersion: rawDashboard.apiVersion,
            metadata: rawDashboard.metadata as unknown as DashboardWithAccessInfo<DashboardV2Spec>['metadata'],
            spec: rawDashboard.spec as unknown as DashboardV2Spec,
            status: rawDashboard.status as DashboardWithAccessInfo<DashboardV2Spec>['status'],
            access: {
              url: result.meta?.url,
              slug: result.meta?.slug,
              canSave: result.meta?.canSave,
              canEdit: result.meta?.canEdit,
              canDelete: result.meta?.canDelete,
              canShare: result.meta?.canShare,
              canStar: result.meta?.canStar,
              canAdmin: result.meta?.canAdmin,
              annotationsPermissions: result.meta?.annotationsPermissions,
              isPublic: result.meta?.publicDashboardEnabled,
            },
          };
          return dashboardWithAccessInfo;
        }
        return ResponseTransformers.ensureV2Response(result);
      });
    } else if (uid) {
      if (!params) {
        const cachedDashboard = stateManager.getDashboardFromCache(uid);
        if (cachedDashboard) {
          return Promise.resolve(cachedDashboard);
        }
      }

      promise = getDashboardAPI('v2').then(async (api) => {
        try {
          return await api.getDashboardDTO(uid, params);
        } catch (e) {
          if (isFetchError(e) && !(e instanceof DashboardVersionError)) {
            console.error('Failed to load dashboard', e);
            e.isHandled = true;
            if (e.status === 404) {
              appEvents.emit(AppEvents.alertError, ['Dashboard not found']);
            }
          }

          throw e;
        }
      });
    } else {
      throw new Error('Dashboard uid or slug required');
    }

    promise.then((result: DashboardWithAccessInfo<DashboardV2Spec>) => {
      impressionSrv.addDashboardImpression(result.metadata.name);
      return result;
    });

    return promise;
  }

  loadSnapshot(slug: string): Promise<DashboardWithAccessInfo<DashboardV2Spec>> {
    const promise = getDashboardSnapshotSrv()
      .getSnapshot(slug)
      .then((r) => ResponseTransformers.ensureV2Response(r));

    promise.then((result: DashboardWithAccessInfo<DashboardV2Spec>) => {
      impressionSrv.addDashboardImpression(result.metadata.name);

      return result;
    });

    return promise;
  }
}

let dashboardLoaderSrv = new DashboardLoaderSrv();
export { dashboardLoaderSrv };

/** @internal
 * Used for tests only
 */
export const setDashboardLoaderSrv = (srv: DashboardLoaderSrv) => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('dashboardLoaderSrv can be only overriden in test environment');
  }

  dashboardLoaderSrv = srv;
};
