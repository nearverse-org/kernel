import { EcsMathReadOnlyVector2 } from '@dcl/ecs-math'
import {
  setCatalystCandidates,
  setAddedCatalystCandidates,
  SET_CATALYST_REALM,
  SetCatalystRealm,
  SET_CATALYST_CANDIDATES,
  SET_ADDED_CATALYST_CANDIDATES,
  SetCatalystCandidates,
  SetAddedCatalystCandidates,
  catalystRealmsScanSuccess,
  catalystRealmsScanRequested,
  SELECT_NETWORK,
  setCatalystRealm
} from './actions'
import { call, put, takeEvery, select, fork, take } from 'redux-saga/effects'
import { REALM, PIN_CATALYST, ETHEREUM_NETWORK, PREVIEW, rootURLPreviewMode } from 'config'
import { waitForMetaConfigurationInitialization } from '../meta/sagas'
import { Candidate, Realm, ServerConnectionStatus } from './types'
import { fetchCatalystRealms, fetchCatalystStatuses, pickCatalystRealm, getRealmFromString, commsStatusUrl } from '.'
import { ping } from './utils/ping'
import { getAddedServers, getCatalystNodesEndpoint, getMinCatalystVersion } from 'shared/meta/selectors'
import {
  getAllCatalystCandidates,
  getFetchContentServer,
  getSelectedNetwork,
  getUpdateProfileServer,
  isRealmInitialized
} from './selectors'
import { saveToPersistentStorage, getFromPersistentStorage } from '../../atomicHelpers/persistentStorage'
import defaultLogger from '../logger'
import {
  BringDownClientAndShowError,
  ErrorContext,
  ReportFatalErrorWithCatalystPayload
} from 'shared/loading/ReportFatalError'
import { CATALYST_COULD_NOT_LOAD } from 'shared/loading/types'
import { gte } from 'semver'
import { parcelAvailable } from 'shared/world/positionThings'

function getLastRealmCacheKey(network: ETHEREUM_NETWORK) {
  return 'last_realm_' + network
}
function getLastRealmCandidatesCacheKey(network: ETHEREUM_NETWORK) {
  return 'last_realm_candidates_' + network
}

export function* daoSaga(): any {
  yield takeEvery(SELECT_NETWORK, loadCatalystRealms)
  yield takeEvery(SET_CATALYST_REALM, cacheCatalystRealm)
  yield takeEvery([SET_CATALYST_CANDIDATES, SET_ADDED_CATALYST_CANDIDATES], cacheCatalystCandidates)
}

/**
 * This method will try to load the candidates as well as the selected realm.
 *
 * The strategy to select the realm in terms of priority is:
 * 1- Realm configured in the URL and cached candidate for that realm (uses cache, forks async candidadte initialization)
 * 2- Realm configured in the URL but no corresponding cached candidate (implies sync candidate initialization)
 * 3- Last cached realm (uses cache, forks async candidadte initialization)
 * 4- Best pick from candidate scan (implies sync candidate initialization)
 */
function* loadCatalystRealms() {
  yield call(waitForMetaConfigurationInitialization)

  let realm: Realm | undefined

  if (!PREVIEW) {
    const network: ETHEREUM_NETWORK = yield select(getSelectedNetwork)

    const cachedRealm: Realm | undefined = yield call(getFromPersistentStorage, getLastRealmCacheKey(network))

    // check for cached realms if any
    if (cachedRealm && (!PIN_CATALYST || cachedRealm.domain === PIN_CATALYST)) {
      const cachedCandidates: Candidate[] = yield call(
        getFromPersistentStorage,
        getLastRealmCandidatesCacheKey(network)
      ) ?? []

      let configuredRealm: Realm
      if (REALM) {
        // if a realm is configured, then try to initialize it from cached candidates
        configuredRealm = yield call(getConfiguredRealm, cachedCandidates)
      } else {
        // in case there are no cached candidates or the realm was not configured in the URL -> use last cached realm
        configuredRealm = cachedRealm
      }

      if (configuredRealm && (yield call(checkValidRealm, configuredRealm))) {
        realm = configuredRealm

        yield fork(initializeCatalystCandidates)
      }
    }

    // if no realm was selected, then do the whole initialization dance
    if (!realm) {
      try {
        yield call(initializeCatalystCandidates)
      } catch (e) {
        ReportFatalErrorWithCatalystPayload(e, ErrorContext.KERNEL_INIT)
        BringDownClientAndShowError(CATALYST_COULD_NOT_LOAD)
        throw e
      }

      realm = yield call(selectRealm)
    }
  } else {
    yield initLocalCatalyst()
    realm = {
      domain: rootURLPreviewMode(),
      catalystName: 'localhost',
      layer: 'stub',
      lighthouseVersion: '0.1'
    }
  }

  if (!realm) {
    throw new Error('Unable to select a realm')
  }

  yield put(setCatalystRealm(realm))

  defaultLogger.info(`Using Catalyst configuration: `, {
    original: yield select((state) => state.dao),
    calculated: {
      fetchContentServer: yield select(getFetchContentServer),
      updateContentServer: yield select(getUpdateProfileServer)
    }
  })
}

function* initLocalCatalyst() {
  yield put(setCatalystCandidates([]))
  yield put(setAddedCatalystCandidates([]))
}

function* waitForCandidates() {
  while ((yield select(getAllCatalystCandidates)).length === 0) {
    yield take(SET_ADDED_CATALYST_CANDIDATES)
  }
}

export function* selectRealm() {
  yield call(waitForCandidates)
  const parcel: EcsMathReadOnlyVector2 = yield parcelAvailable()

  const allCandidates: Candidate[] = yield select(getAllCatalystCandidates)

  let realm = yield call(getConfiguredRealm, allCandidates)
  if (!realm) {
    realm = yield call(pickCatalystRealm, allCandidates, [parcel.x, parcel.y])
  }
  return realm
}

function getConfiguredRealm(candidates: Candidate[]) {
  if (REALM) {
    return getRealmFromString(REALM, candidates)
  }
}

function* filterCandidatesByCatalystVersion(candidates: Candidate[]) {
  const minCatalystVersion: string | undefined = yield select(getMinCatalystVersion)
  return minCatalystVersion
    ? candidates.filter(({ catalystVersion }) => gte(catalystVersion, minCatalystVersion))
    : candidates
}

function* initializeCatalystCandidates() {
  yield put(catalystRealmsScanRequested())
  const catalystsNodesEndpointURL: string | undefined = yield select(getCatalystNodesEndpoint)
  const candidates: Candidate[] = yield call(fetchCatalystRealms, catalystsNodesEndpointURL)
  const filteredCandidates: Candidate[] = PIN_CATALYST
    ? candidates
    : yield call(filterCandidatesByCatalystVersion, candidates)

  yield put(setCatalystCandidates(filteredCandidates))

  const added: string[] = PIN_CATALYST ? [] : yield select(getAddedServers)
  const addedCandidates: Candidate[] = yield call(
    fetchCatalystStatuses,
    added.map((url) => ({ domain: url }))
  )
  const filteredAddedCandidates = yield call(filterCandidatesByCatalystVersion, addedCandidates)

  yield put(setAddedCatalystCandidates(filteredAddedCandidates))

  yield put(catalystRealmsScanSuccess())
}

function* checkValidRealm(realm: Realm) {
  const realmHasValues = realm && realm.domain && realm.catalystName && realm.layer
  if (!realmHasValues) {
    return false
  }
  const minCatalystVersion = yield select(getMinCatalystVersion)
  const pingResult = yield ping(commsStatusUrl(realm.domain))
  const catalystVersion = pingResult.result?.env.catalystVersion ?? '0.0.0'
  return (
    pingResult.status === ServerConnectionStatus.OK && (!minCatalystVersion || gte(catalystVersion, minCatalystVersion))
  )
}

function* cacheCatalystRealm(action: SetCatalystRealm) {
  const network: ETHEREUM_NETWORK = yield select(getSelectedNetwork)
  yield call(saveToPersistentStorage, getLastRealmCacheKey(network), action.payload)
}

function* cacheCatalystCandidates(_action: SetCatalystCandidates | SetAddedCatalystCandidates) {
  const allCandidates = yield select(getAllCatalystCandidates)
  const network: ETHEREUM_NETWORK = yield select(getSelectedNetwork)
  yield call(saveToPersistentStorage, getLastRealmCandidatesCacheKey(network), allCandidates)
}

export function* waitForRealmInitialized() {
  while (!(yield select(isRealmInitialized))) {
    yield take(SET_CATALYST_REALM)
  }
}
