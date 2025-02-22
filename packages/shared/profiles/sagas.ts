import { EntityType, Hashing, Fetcher } from 'dcl-catalyst-commons'
import { ContentClient, DeploymentData } from 'dcl-catalyst-client'
import { call, throttle, put, select, takeEvery } from 'redux-saga/effects'

import { getServerConfigurations, ethereumConfigurations, RESET_TUTORIAL, ETHEREUM_NETWORK, PREVIEW } from 'config'

import defaultLogger from 'shared/logger'
import {
  PROFILE_REQUEST,
  PROFILE_SUCCESS,
  PROFILE_RANDOM,
  SAVE_PROFILE_REQUEST,
  ProfileRequestAction,
  profileSuccess,
  ProfileRandomAction,
  ProfileSuccessAction,
  SaveProfileRequest,
  saveProfileSuccess,
  profileRequest,
  saveProfileFailure,
  addedProfileToCatalog,
  saveProfileRequest,
  LOCAL_PROFILE_RECEIVED,
  LocalProfileReceived,
  deployProfile,
  DEPLOY_PROFILE_REQUEST,
  deployProfileSuccess,
  deployProfileFailure,
  profileSavedNotDeployed,
  DeployProfile,
  localProfileSentToRenderer
} from './actions'
import { getProfile, hasConnectedWeb3 } from './selectors'
import { processServerProfile } from './transformations/processServerProfile'
import { profileToRendererFormat } from './transformations/profileToRendererFormat'
import { buildServerMetadata, ensureServerFormat, ServerFormatProfile } from './transformations/profileToServerFormat'
import { Profile, ContentFile, Avatar, ProfileType } from './types'
import { ExplorerIdentity } from 'shared/session/types'
import { Authenticator } from 'dcl-crypto'
import {
  getUpdateProfileServer,
  getResizeService,
  isResizeServiceUrl,
  getCatalystServer,
  getSelectedNetwork,
  getFetchContentServer
} from '../dao/selectors'
import { backupProfile } from 'shared/profiles/generateRandomUserProfile'
import { takeLatestById } from './utils/takeLatestById'
import { getCurrentUserId, getCurrentIdentity, getCurrentNetwork } from 'shared/session/selectors'
import { USER_AUTHENTIFIED } from 'shared/session/actions'
import { ProfileAsPromise } from './ProfileAsPromise'
import { fetchOwnedENS } from 'shared/web3'
import { requestLocalProfileToPeers, updateCommsUser } from 'shared/comms'
import { waitForRealmInitialized } from 'shared/dao/sagas'
import { waitForRendererInstance } from 'shared/renderer/sagas'
import { base64ToBlob } from 'atomicHelpers/base64ToBlob'
import { LocalProfilesRepository } from './LocalProfilesRepository'
import { getProfileType } from './getProfileType'
import { BringDownClientAndShowError, ErrorContext, ReportFatalError } from 'shared/loading/ReportFatalError'
import { UNEXPECTED_ERROR } from 'shared/loading/types'
import { fetchParcelsWithAccess } from './fetchLand'
import { ParcelsWithAccess } from '@dcl/legacy-ecs'
import { getUnityInstance } from 'unity-interface/IUnityInterface'
import { store } from 'shared/store/isolatedStore'
import { createFakeName } from './utils/fakeName'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const toBuffer = require('blob-to-buffer')

const concatenatedActionTypeUserId = (action: { type: string; payload: { userId: string } }) =>
  action.type + action.payload.userId

export const takeLatestByUserId = (patternOrChannel: any, saga: any, ...args: any) =>
  takeLatestById(patternOrChannel, concatenatedActionTypeUserId, saga, ...args)

// This repository is for local profiles owned by this browser (without wallet)
export const localProfilesRepo = new LocalProfilesRepository()

/**
 * This saga handles both passports and assets required for the renderer to show the
 * users' inventory and avatar editor.
 *
 * When the renderer is initialized, it will fetch the asset catalog and submit it to the renderer.
 *
 * Whenever a passport is requested, it will fetch it and store it locally (see also: `selectors.ts`)
 *
 * If a user avatar was not found, it will create a random passport (see: `handleRandomAsSuccess`)
 *
 * Lastly, we handle save requests by submitting both to the avatar legacy server as well as to the profile server.
 *
 * It's *very* important for the renderer to never receive a passport with items that have not been loaded into the catalog.
 */
export function* profileSaga(): any {
  yield takeEvery(USER_AUTHENTIFIED, initialProfileLoad)
  yield takeLatestByUserId(PROFILE_REQUEST, handleFetchProfile)
  yield takeLatestByUserId(PROFILE_SUCCESS, submitProfileToRenderer)
  yield takeLatestByUserId(PROFILE_RANDOM, handleRandomAsSuccess)
  yield takeLatestByUserId(SAVE_PROFILE_REQUEST, handleSaveAvatar)
  yield takeLatestByUserId(LOCAL_PROFILE_RECEIVED, handleLocalProfile)
  yield throttle(3000, DEPLOY_PROFILE_REQUEST, handleDeployProfile)
}

function* initialProfileLoad() {
  yield call(waitForRealmInitialized)

  // initialize profile
  const identity: ExplorerIdentity = yield select(getCurrentIdentity)
  const userId = identity.address

  let profile = undefined

  try {
    profile = yield ProfileAsPromise(userId, undefined, getProfileType(identity))
  } catch (e) {
    ReportFatalError(e, ErrorContext.KERNEL_INIT, { userId: userId })
    BringDownClientAndShowError(UNEXPECTED_ERROR)
    throw e
  }

  let profileDirty: boolean = false

  if (!profile.hasClaimedName) {
    const net: keyof typeof ethereumConfigurations = yield select(getCurrentNetwork)
    const names = yield fetchOwnedENS(ethereumConfigurations[net].names, userId)

    // patch profile to re-add missing name
    profile = { ...profile, name: names[0], hasClaimedName: true }

    if (names && names.length > 0) {
      defaultLogger.info(`Found missing claimed name '${names[0]}' for profile ${userId}, consolidating profile... `)
      profileDirty = true
    }
  }

  const isFace256Resized = yield select(isResizeServiceUrl, profile.avatar.snapshots?.face256)

  if (isFace256Resized) {
    // setting dirty profile, as at least one of the face images are taken from a local blob
    profileDirty = true
  }

  if (RESET_TUTORIAL) {
    profile = { ...profile, tutorialStep: 0 }
    profileDirty = true
  }

  if (profileDirty) {
    scheduleProfileUpdate(profile)
  }

  updateCommsUser({ version: profile.version })
}

/**
 * Schedule profile update post login (i.e. comms authenticated & established).
 *
 * @param profile Updated profile
 */
function scheduleProfileUpdate(profile: Profile) {
  const unsubscribe = store.subscribe(() => {
    const initialized = store.getState().comms.initialized
    if (initialized) {
      unsubscribe()
      store.dispatch(saveProfileRequest(profile))
    }
  })
}

export function* doesProfileExist(userId: string): any {
  try {
    const profiles: { avatars: object[] } = yield profileServerRequest(userId)

    return profiles.avatars.length > 0
  } catch (error) {
    if (error.message !== 'Profile not found') {
      defaultLogger.log(`Error requesting profile for auth check ${userId}, `, error)
    }
  }
  return false
}

export function* handleFetchProfile(action: ProfileRequestAction): any {
  const { userId, profileType, version } = action.payload

  const currentId = yield select(getCurrentUserId)
  let profile: ServerFormatProfile | null = null
  let hasConnectedWeb3 = false
  try {
    if ((PREVIEW || profileType === ProfileType.LOCAL) && currentId !== userId) {
      const peerProfile: Profile = yield call(requestLocalProfileToPeers, userId)
      if (peerProfile) {
        profile = ensureServerFormat(peerProfile)
        profile.hasClaimedName = false // for now, comms profiles can't have claimed names
      }
    } else {
      const profiles: { avatars: ServerFormatProfile[] } = yield call(profileServerRequest, userId, version)

      if (profiles.avatars.length !== 0) {
        profile = profiles.avatars[0]
        profile.hasClaimedName = !!profile.name && profile.hasClaimedName // old lambdas profiles don't have claimed names if they don't have the "name" property
        hasConnectedWeb3 = true
      }
    }
  } catch (error) {
    // we throw here because it seems this is an unrecoverable error
    throw new Error(`Error requesting profile for ${userId}: ${error}`)
  }

  if (currentId === userId) {
    const net: ETHEREUM_NETWORK = yield select(getCurrentNetwork)
    const localProfile = yield call(fetchProfileLocally, userId, net)
    // checks if profile name was changed on builder
    if (profile && localProfile && localProfile.name !== profile.name) {
      localProfile.name = profile.name
    }
    if (!profile || (localProfile && profile.version < localProfile.version)) {
      profile = localProfile
    }

    const identity: ExplorerIdentity = yield select(getCurrentIdentity)
    if (profile) {
      profile.ethAddress = identity.rawAddress
    }
  }

  if (!profile) {
    defaultLogger.info(`Profile for ${userId} not found, generating random profile`)
    profile = yield call(generateRandomUserProfile, userId)
  }

  if (currentId === userId && profile) {
    profile.email = ''
  }

  yield populateFaceIfNecessary(profile, '256')
  yield populateFaceIfNecessary(profile, '128')

  const passport: Profile = yield call(processServerProfile, userId, profile)

  yield put(profileSuccess(userId, passport, hasConnectedWeb3))
}

function lastSegment(url: string) {
  const segments = url.split('/')
  const segment = segments[segments.length - 1]
  return segment
}

function* populateFaceIfNecessary(profile: any, resolution: string) {
  const selector = `face${resolution}`
  if (
    profile.avatar?.snapshots &&
    (!profile.avatar?.snapshots[selector] || lastSegment(profile.avatar.snapshots[selector]) === resolution) && // XXX - check if content === resolution to fix current issue with corrupted profiles https://github.com/decentraland/explorer/issues/1061 - moliva - 25/06/2020
    profile.avatar?.snapshots?.face
  ) {
    try {
      const resizeServiceUrl: string = yield select(getResizeService)
      const faceUrlSegments = profile.avatar.snapshots.face.split('/')
      const path = `${faceUrlSegments[faceUrlSegments.length - 1]}/${resolution}`
      let faceUrl = `${resizeServiceUrl}/${path}`

      // head to resize url in the current catalyst before populating
      let response = yield call(fetch, faceUrl, { method: 'HEAD' })
      if (!response.ok) {
        // if resize service is not available for this image, try with fallback server
        const net: ETHEREUM_NETWORK = yield select(getSelectedNetwork)
        const fallbackServiceUrl = getServerConfigurations(net).fallbackResizeServiceUrl
        if (fallbackServiceUrl !== resizeServiceUrl) {
          faceUrl = `${fallbackServiceUrl}/${path}`

          response = yield call(fetch, faceUrl, { method: 'HEAD' })
        }
      }

      if (response.ok) {
        // only populate image field if resize service responded correctly
        profile.avatar = { ...profile.avatar, snapshots: { ...profile.avatar?.snapshots, [selector]: faceUrl } }
      }
    } catch (e) {
      defaultLogger.error(`error while resizing image for user ${profile.userId} for resolution ${resolution}`, e)
    }
  }
}

export async function profileServerRequest(userId: string, version?: number) {
  const state = store.getState()
  const catalystUrl = getCatalystServer(state)

  try {
    // TODO: We should use catalyst client here. But it cannot be updated to use version in profiles request because
    // the latest version is not compatible with kernel build.
    // This should be changed once this issue is solved: https://github.com/decentraland/catalyst-client/issues/109

    let url = `${catalystUrl}/lambdas/profiles?id=${userId}`
    if (version) url = url + `&version=${version}`

    const fetcher = new Fetcher()
    const profiles = await fetcher.fetchJson(url)

    return profiles[0] || { avatars: [] }
  } catch (e) {
    defaultLogger.error(e)
    return { avatars: [] }
  }
}

function* handleRandomAsSuccess(action: ProfileRandomAction): any {
  // TODO (eordano, 16/Sep/2019): See if there's another way around people expecting PASSPORT_SUCCESS
  yield put(profileSuccess(action.payload.userId, action.payload.profile))
}

function* handleLocalProfile(action: LocalProfileReceived) {
  const { userId, profile } = action.payload

  const existingProfile = yield select(getProfile, userId)
  const connectedWeb3 = yield select(hasConnectedWeb3, userId)

  if (!existingProfile || existingProfile.version < profile.version) {
    yield put(profileSuccess(userId, profile, connectedWeb3))
  }
}

function* submitProfileToRenderer(action: ProfileSuccessAction): any {
  const profile = { ...action.payload.profile }
  if (profile.avatar) {
    const { snapshots } = profile.avatar
    // set face variants if missing before sending profile to renderer
    profile.avatar.snapshots = {
      ...snapshots,
      face256: snapshots.face256
    }
  }

  if ((yield select(getCurrentUserId)) === action.payload.userId) {
    yield call(sendLoadProfile, profile)
  } else {
    const forRenderer = profileToRendererFormat(profile)
    forRenderer.hasConnectedWeb3 = action.payload.hasConnectedWeb3

    yield call(waitForRendererInstance)
    getUnityInstance().AddUserProfileToCatalog(forRenderer)

    yield put(addedProfileToCatalog(action.payload.userId, forRenderer))
  }
}

function* sendLoadProfile(profile: Profile) {
  const identity: ExplorerIdentity = yield select(getCurrentIdentity)
  const parcels: ParcelsWithAccess = !identity.hasConnectedWeb3 ? [] : yield fetchParcelsWithAccess(identity.address)
  const rendererFormat = profileToRendererFormat(profile, { identity, parcels })
  yield call(waitForRendererInstance)
  getUnityInstance().LoadProfile(rendererFormat)
  yield put(localProfileSentToRenderer())
}

function* handleSaveAvatar(saveAvatar: SaveProfileRequest) {
  const userId: string = saveAvatar.payload.profile.userId || (yield select(getCurrentUserId))

  try {
    const savedProfile: Profile | null = yield select(getProfile, userId)
    const currentVersion: number = savedProfile?.version && savedProfile?.version > 0 ? savedProfile?.version : 0
    const profile = { ...savedProfile, ...saveAvatar.payload.profile, ...{ version: currentVersion + 1 } } as Profile

    const identity: ExplorerIdentity = yield select(getCurrentIdentity)
    const network: ETHEREUM_NETWORK = yield select(getCurrentNetwork)

    yield localProfilesRepo.persist(identity.address, network, profile)

    yield put(saveProfileSuccess(userId, profile.version, profile))

    // only update profile on server if wallet is connected
    if (identity.hasConnectedWeb3) {
      yield put(deployProfile(profile))
    } else {
      yield put(profileSavedNotDeployed(userId, profile.version, profile))
    }

    yield put(profileRequest(userId))
  } catch (error) {
    yield put(saveProfileFailure(userId, 'unknown reason'))
  }
}

function* handleDeployProfile(deployProfileAction: DeployProfile) {
  const url: string = yield select(getUpdateProfileServer)
  const identity: ExplorerIdentity = yield select(getCurrentIdentity)
  const userId: string = yield select(getCurrentUserId)
  const profile: Profile = deployProfileAction.payload.profile
  try {
    yield call(modifyAvatar, {
      url,
      userId,
      identity,
      profile
    })
    yield put(deployProfileSuccess(userId, profile.version, profile))
  } catch (e) {
    defaultLogger.error('Error deploying profile!', e)
    yield put(deployProfileFailure(userId, profile, e))
  }
}

export async function fetchProfileLocally(address: string, network: ETHEREUM_NETWORK) {
  const profile: Profile | null = await localProfilesRepo.get(address, network)
  if (profile?.userId === address) {
    return ensureServerFormat(profile)
  } else {
    return null
  }
}

async function buildSnapshotContent(selector: string, value: string): Promise<[string, string, ContentFile?]> {
  let hash: string
  let contentFile: ContentFile | undefined

  const name = `${selector}.png`

  if (isResizeServiceUrl(store.getState(), value)) {
    // value is coming in a resize service url => generate image & upload content
    const blob = await fetch(value).then((r) => r.blob())

    contentFile = await makeContentFile(name, blob)
    hash = await Hashing.calculateHash(contentFile)
  } else if (value.includes('://')) {
    // value is already a URL => use existing hash
    hash = value.split('/').pop()!
  } else {
    // value is coming in base 64 => convert to blob & upload content
    const blob = base64ToBlob(value)

    contentFile = await makeContentFile(name, blob)
    hash = await Hashing.calculateHash(contentFile)
  }

  return [name, hash, contentFile]
}

async function modifyAvatar(params: { url: string; userId: string; identity: ExplorerIdentity; profile: Profile }) {
  const { url, profile, identity } = params
  const { avatar } = profile

  const newAvatar = { ...avatar }

  const files = new Map<string, Buffer>()

  const snapshots = avatar.snapshots || (profile as any).snapshots
  const content = new Map()
  if (snapshots) {
    const newSnapshots: Record<string, string> = {}
    for (const [selector, value] of Object.entries(snapshots)) {
      const [name, hash, contentFile] = await buildSnapshotContent(selector, value as any)

      newSnapshots[selector] = hash
      content.set(name, hash)
      contentFile && files.set(contentFile.name, contentFile.content)
    }
    newAvatar.snapshots = newSnapshots as Avatar['snapshots']
  }

  const metadata = buildServerMetadata({ ...profile, avatar: newAvatar })

  return deploy(url, identity, metadata, files, content)
}

async function deploy(
  url: string,
  identity: ExplorerIdentity,
  metadata: any,
  contentFiles: Map<string, Buffer>,
  contentHashes: Map<string, string>
) {
  // Build the client
  const catalyst = new ContentClient(url, 'explorer-kernel-profile')

  const entityWithoutNewFilesPayload = {
    type: EntityType.PROFILE,
    pointers: [identity.address],
    hashesByKey: contentHashes,
    metadata
  }

  // Build entity and group all files
  const preparationData = await (contentFiles.size
    ? catalyst.buildEntity({ type: EntityType.PROFILE, pointers: [identity.address], files: contentFiles, metadata })
    : catalyst.buildEntityWithoutNewFiles(entityWithoutNewFilesPayload))
  // sign the entity id
  const authChain = Authenticator.signPayload(identity, preparationData.entityId)
  // Build the deploy data
  const deployData: DeploymentData = { ...preparationData, authChain }
  // Deploy the actual entity
  return catalyst.deployEntity(deployData)
}

export function makeContentFile(path: string, content: string | Blob): Promise<ContentFile> {
  return new Promise((resolve, reject) => {
    if (typeof content === 'string') {
      const buffer = Buffer.from(content)
      resolve({ name: path, content: buffer })
    } else if (content instanceof Blob) {
      toBuffer(content, (err: Error, buffer: Buffer) => {
        if (err) reject(err)
        resolve({ name: path, content: buffer })
      })
    } else {
      reject(new Error('Unable to create ContentFile: content must be a string or a Blob'))
    }
  })
}

function randomBetween(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1) + min)
}

export async function generateRandomUserProfile(userId: string): Promise<Profile> {
  const _number = randomBetween(1, 160)

  let profile: Profile | undefined = undefined
  try {
    const profiles: { avatars: Profile[] } = await profileServerRequest(`default${_number}`)
    if (profiles.avatars.length !== 0) {
      profile = profiles.avatars[0]
    }
  } catch (e) {
    // in case something fails keep going and use backup profile
  }

  if (!profile) {
    profile = backupProfile(getFetchContentServer(store.getState()), userId) as any as Profile
  }

  profile.avatar.snapshots.face256 = profile.avatar.snapshots.face256 ?? (profile.avatar.snapshots as any).face
  profile.unclaimedName = createFakeName()
  profile.hasClaimedName = false
  profile.tutorialStep = 0
  profile.version = -1 // We signal random user profiles with -1

  return profile
}
