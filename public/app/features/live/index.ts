import { config, getBackendSrv, setGrafanaLiveSrv } from '@grafana/runtime';
import { liveTimer } from 'app/features/dashboard/dashgrid/liveTimer';

import { contextSrv } from '../../core/services/context_srv';
import { loadUrlToken } from '../../core/utils/urlToken';

import { CentrifugeService } from './centrifuge/service';
import { GrafanaLiveService } from './live';

export function initGrafanaLive() {
  const centrifugeServiceDeps = {
    appUrl: `${window.location.origin}${config.appSubUrl}`,
    namespace: config.liveNamespaced ? config.namespace : `${contextSrv.user.orgId}`,
    orgRole: contextSrv.user.orgRole,
    // Public dashboard viewers have no session to authenticate a live connection
    // with -- connecting is guaranteed to fail auth and just spams /api/live/ws
    // and /api/login/ping (see CentrifugeService's onError workaround for
    // grafana/grafana#72792). Same convention as AlertStatesDataLayer /
    // DashboardAnnotationsDataLayer, which skip their own privileged calls the
    // same way.
    liveEnabled: config.liveEnabled && !config.publicDashboardAccessToken,
    dataStreamSubscriberReadiness: liveTimer.ok.asObservable(),
    grafanaAuthToken: loadUrlToken(),
  };

  const centrifugeSrv = new CentrifugeService(centrifugeServiceDeps);

  setGrafanaLiveSrv(
    new GrafanaLiveService({
      centrifugeSrv,
      backendSrv: getBackendSrv(),
    })
  );
}
