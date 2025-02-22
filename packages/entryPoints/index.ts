declare const globalThis: { DecentralandKernel: IDecentralandKernel }

import { sdk } from '@dcl/schemas'
import defaultLogger, { createLogger } from 'shared/logger'
import { IDecentralandKernel, IEthereumProvider, KernelOptions, KernelResult, LoginState } from '@dcl/kernel-interface'
import { BringDownClientAndShowError, ErrorContext, ReportFatalError } from 'shared/loading/ReportFatalError'
import { renderingInBackground, renderingInForeground } from 'shared/loading/types'
import { worldToGrid } from '../atomicHelpers/parcelScenePositions'
import { DEBUG_WS_MESSAGES, ETHEREUM_NETWORK, HAS_INITIAL_POSITION_MARK, OPEN_AVATAR_EDITOR } from '../config/index'
import 'unity-interface/trace'
import { lastPlayerPosition, teleportObservable } from 'shared/world/positionThings'
import { getPreviewSceneId, loadPreviewScene, startUnitySceneWorkers } from '../unity-interface/dcl'
import { initializeUnity } from '../unity-interface/initializer'
import { HUDElementID, RenderProfile } from 'shared/types'
import { foregroundChangeObservable, isForeground } from 'shared/world/worldState'
import { getCurrentIdentity } from 'shared/session/selectors'
import { realmInitialized } from 'shared/dao'
import { EnsureProfile } from 'shared/profiles/ProfileAsPromise'
import { ensureMetaConfigurationInitialized, waitForMessageOfTheDay } from 'shared/meta'
import { FeatureFlags, WorldConfig } from 'shared/meta/types'
import { getFeatureFlags, getWorldConfig, isFeatureEnabled } from 'shared/meta/selectors'
import { kernelConfigForRenderer } from '../unity-interface/kernelConfigForRenderer'
import { startRealmsReportToRenderer } from 'unity-interface/realmsForRenderer'
import { isWaitingTutorial } from 'shared/loading/selectors'
import { ensureUnityInterface } from 'shared/renderer'
import { globalObservable } from 'shared/observables'
import { initShared } from 'shared'
import { setResourcesURL } from 'shared/location'
import { WebSocketProvider } from 'eth-connect'
import { resolveUrlFromUrn } from '@dcl/urn-resolver'
import { IUnityInterface } from 'unity-interface/IUnityInterface'
import { store } from 'shared/store/isolatedStore'
import { onLoginCompleted } from 'shared/session/sagas'
import { authenticate, initSession } from 'shared/session/actions'
import { localProfilesRepo } from 'shared/profiles/sagas'
import { getStoredSession } from 'shared/session'
import { setPersistentStorage } from 'atomicHelpers/persistentStorage'
import { getSelectedNetwork } from 'shared/dao/selectors'
import { clientDebug } from 'unity-interface/ClientDebug'

const logger = createLogger('kernel: ')

function configureTaskbarDependentHUD(i: IUnityInterface, voiceChatEnabled: boolean, builderInWorldEnabled: boolean) {
  // The elements below, require the taskbar to be active before being activated.

  i.ConfigureHUDElement(
    HUDElementID.TASKBAR,
    { active: true, visible: true },
    {
      enableVoiceChat: voiceChatEnabled,
      enableQuestPanel: isFeatureEnabled(store.getState(), FeatureFlags.QUESTS, false)
    }
  )
  i.ConfigureHUDElement(HUDElementID.WORLD_CHAT_WINDOW, { active: true, visible: true })

  i.ConfigureHUDElement(HUDElementID.CONTROLS_HUD, { active: true, visible: false })
  i.ConfigureHUDElement(HUDElementID.HELP_AND_SUPPORT_HUD, { active: true, visible: false })
  i.ConfigureHUDElement(HUDElementID.BUILDER_PROJECTS_PANEL, { active: builderInWorldEnabled, visible: false })
}

async function resolveBaseUrl(urn: string): Promise<string> {
  if (urn.startsWith('urn:')) {
    const t = await resolveUrlFromUrn(urn)
    if (t) {
      return (t + '/').replace(/(\/)+$/, '/')
    }
    throw new Error('Cannot resolve content for URN ' + urn)
  }
  return (urn + '/').replace(/(\/)+$/, '/')
}

function orFail(withError: string): never {
  throw new Error(withError)
}

function authenticateWhenItsReady(provider: IEthereumProvider, isGuest: boolean) {
  const loginState = store.getState().session.loginState

  if (loginState === LoginState.WAITING_PROVIDER) {
    store.dispatch(authenticate(provider, isGuest))
  } else {
    const unsubscribe = store.subscribe(() => {
      const loginState = store.getState().session.loginState
      if (loginState === LoginState.WAITING_PROVIDER) {
        unsubscribe()
        store.dispatch(authenticate(provider, isGuest))
      }
    })
  }
}

globalThis.DecentralandKernel = {
  async initKernel(options: KernelOptions): Promise<KernelResult> {
    options.kernelOptions.baseUrl = await resolveBaseUrl(
      options.kernelOptions.baseUrl || orFail('MISSING kernelOptions.baseUrl')
    )
    options.rendererOptions.baseUrl = await resolveBaseUrl(
      options.rendererOptions.baseUrl || orFail('MISSING rendererOptions.baseUrl')
    )

    if (options.kernelOptions.persistentStorage) {
      setPersistentStorage(options.kernelOptions.persistentStorage)
    }

    const { container } = options.rendererOptions
    const { baseUrl } = options.kernelOptions

    if (baseUrl) {
      setResourcesURL(baseUrl)
    }

    if (!container) throw new Error('cannot find element #gameContainer')

    // initShared must be called immediately, before return
    initShared()

    // initInternal must be called asynchronously, _after_ returning
    async function initInternal() {
      runCompatibilityChecks()

      // Initializes the Session Saga
      store.dispatch(initSession())

      await initializeUnity(options.rendererOptions)
      await loadWebsiteSystems(options.kernelOptions)
    }

    setTimeout(
      () =>
        initInternal().catch((err) => {
          ReportFatalError(err, ErrorContext.WEBSITE_INIT)
          BringDownClientAndShowError(err.toString())
        }),
      0
    )

    return {
      authenticate(provider: any, isGuest: boolean) {
        if (!provider) {
          throw new Error('A provider must be provided')
        }
        if (typeof provider === 'string') {
          if (provider.startsWith('ws:') || provider.startsWith('wss:')) {
            provider = new WebSocketProvider(provider)
          } else {
            throw new Error('Text provider can only be WebSocket')
          }
        }
        authenticateWhenItsReady(provider, isGuest)
      },
      on: globalObservable.on.bind(globalObservable),
      version: 'mockedversion',
      // this method is used for auto-login
      async hasStoredSession(address: string, networkId: number) {
        if (!(await getStoredSession(address))) return { result: false }

        const profile = await localProfilesRepo.get(
          address,
          networkId === 1 ? ETHEREUM_NETWORK.MAINNET : ETHEREUM_NETWORK.ROPSTEN
        )

        return { result: !!profile, profile: profile || null } as any
      }
    }
  }
}

function runCompatibilityChecks() {
  const qs = new URLSearchParams(document.location.search)

  if (qs.has('NO_ASSET_BUNDLES')) {
    throw new Error(
      'NO_ASSET_BUNDLES option was deprecated, it is now a FeatureFlag, use DISABLE_ASSET_BUNDLES or ENABLE_ASSET_BUNDLES instead'
    )
  }
}

async function loadWebsiteSystems(options: KernelOptions['kernelOptions']) {
  const i = (await ensureUnityInterface()).unityInterface

  // NOTE(Brian): Scene download manager uses meta config to determine which empty parcels we want
  //              so ensuring meta configuration is initialized in this stage is a must
  // NOTE(Pablo): We also need meta configuration to know if we need to enable voice chat
  await ensureMetaConfigurationInitialized()

  //Note: This should be sent to unity before any other feature because some features may need a system init from FeatureFlag
  //      For example disable AssetBundles needs a system from FeatureFlag
  i.SetFeatureFlagsConfiguration(getFeatureFlags(store.getState()))

  const questEnabled = isFeatureEnabled(store.getState(), FeatureFlags.QUESTS, false)
  const worldConfig: WorldConfig | undefined = getWorldConfig(store.getState())
  const renderProfile = worldConfig ? worldConfig.renderProfile ?? RenderProfile.DEFAULT : RenderProfile.DEFAULT
  i.SetRenderProfile(renderProfile)
  const enableNewTutorialCamera = worldConfig ? worldConfig.enableNewTutorialCamera ?? false : false

  // killswitch, disable asset bundles
  if (!isFeatureEnabled(store.getState(), FeatureFlags.ASSET_BUNDLES, false)) {
    i.SetDisableAssetBundles()
  }

  i.ConfigureHUDElement(HUDElementID.MINIMAP, { active: true, visible: true })
  i.ConfigureHUDElement(HUDElementID.NOTIFICATION, { active: true, visible: true })
  i.ConfigureHUDElement(HUDElementID.AVATAR_EDITOR, { active: true, visible: OPEN_AVATAR_EDITOR })
  i.ConfigureHUDElement(HUDElementID.SIGNUP, { active: true, visible: false })
  i.ConfigureHUDElement(HUDElementID.LOADING_HUD, { active: true, visible: false })
  i.ConfigureHUDElement(HUDElementID.AVATAR_NAMES, { active: true, visible: true })
  i.ConfigureHUDElement(HUDElementID.SETTINGS_PANEL, { active: true, visible: false })
  i.ConfigureHUDElement(HUDElementID.EXPRESSIONS, { active: true, visible: true })
  i.ConfigureHUDElement(HUDElementID.EMOTES, { active: true, visible: false })
  i.ConfigureHUDElement(HUDElementID.PLAYER_INFO_CARD, { active: true, visible: true })
  i.ConfigureHUDElement(HUDElementID.AIRDROPPING, { active: true, visible: true })
  i.ConfigureHUDElement(HUDElementID.TERMS_OF_SERVICE, { active: true, visible: true })
  i.ConfigureHUDElement(HUDElementID.OPEN_EXTERNAL_URL_PROMPT, { active: true, visible: false })
  i.ConfigureHUDElement(HUDElementID.NFT_INFO_DIALOG, { active: true, visible: false })
  i.ConfigureHUDElement(HUDElementID.TELEPORT_DIALOG, { active: true, visible: false })
  i.ConfigureHUDElement(HUDElementID.QUESTS_PANEL, { active: questEnabled, visible: false })
  i.ConfigureHUDElement(HUDElementID.QUESTS_TRACKER, { active: questEnabled, visible: true })

  onLoginCompleted()
    .then(() => {
      const identity = getCurrentIdentity(store.getState())!

      const VOICE_CHAT_ENABLED = true
      const BUILDER_IN_WORLD_ENABLED =
        identity.hasConnectedWeb3 && isFeatureEnabled(store.getState(), FeatureFlags.BUILDER_IN_WORLD, false)

      const configForRenderer = kernelConfigForRenderer()
      configForRenderer.comms.voiceChatEnabled = VOICE_CHAT_ENABLED
      configForRenderer.network = getSelectedNetwork(store.getState())

      i.SetKernelConfiguration(configForRenderer)

      configureTaskbarDependentHUD(i, VOICE_CHAT_ENABLED, BUILDER_IN_WORLD_ENABLED)

      i.ConfigureHUDElement(HUDElementID.PROFILE_HUD, { active: true, visible: true })
      i.ConfigureHUDElement(HUDElementID.USERS_AROUND_LIST_HUD, { active: VOICE_CHAT_ENABLED, visible: false })
      i.ConfigureHUDElement(HUDElementID.FRIENDS, { active: identity.hasConnectedWeb3, visible: false })

      const tutorialConfig = {
        fromDeepLink: HAS_INITIAL_POSITION_MARK,
        enableNewTutorialCamera: enableNewTutorialCamera
      }

      EnsureProfile(identity.address)
        .then((profile) => {
          i.ConfigureTutorial(profile.tutorialStep, tutorialConfig)
          i.ConfigureHUDElement(HUDElementID.GRAPHIC_CARD_WARNING, { active: true, visible: true })

          // NOTE: here we make sure that if signup (tutorial) just finished
          // the player is set to the correct spawn position plus we make sure that the proper scene is loaded
          if (isWaitingTutorial(store.getState())) {
            teleportObservable.notifyObservers(worldToGrid(lastPlayerPosition))
          }
        })
        .catch((e) => logger.error(`error getting profile ${e}`))
    })
    .catch((e) => {
      logger.error('error on configuring taskbar & friends hud / tutorial. Trying to default to simple taskbar', e)
      configureTaskbarDependentHUD(i, false, false)
    })

  startRealmsReportToRenderer()

  await realmInitialized()

  function reportForeground() {
    if (isForeground()) {
      store.dispatch(renderingInForeground())
      i.ReportFocusOn()
    } else {
      store.dispatch(renderingInBackground())
      i.ReportFocusOff()
    }
  }

  foregroundChangeObservable.add(reportForeground)
  reportForeground()

  waitForMessageOfTheDay()
    .then((messageOfTheDay) => {
      i.ConfigureHUDElement(
        HUDElementID.MESSAGE_OF_THE_DAY,
        { active: !!messageOfTheDay, visible: false },
        messageOfTheDay
      )
    })
    .catch(() => {
      /*noop*/
    })

  await startUnitySceneWorkers()

  teleportObservable.notifyObservers(worldToGrid(lastPlayerPosition))

  if (options.previewMode) {
    i.SetDisableAssetBundles()
    await startPreview()
    // tslint:disable: no-commented-out-code
    // const position = pickWorldSpawnpoint(scene)
    // i.Teleport(position)
    // teleportObservable.notifyObservers(position.position)
    // tslint:enable: no-commented-out-code
  }

  return true
}

export async function startPreview() {
  void getPreviewSceneId()
    .then(async (sceneData) => {
      if (sceneData.sceneId) {
        const { unityInterface } = await ensureUnityInterface()
        unityInterface.SetKernelConfiguration({
          debugConfig: {
            sceneDebugPanelTargetSceneId: sceneData.sceneId,
            sceneLimitsWarningSceneId: sceneData.sceneId
          }
        })
        clientDebug.ToggleSceneBoundingBoxes(sceneData.sceneId, false).catch((e) => defaultLogger.error(e))
        unityInterface.SendMessageToUnity('Main', 'TogglePreviewMenu', JSON.stringify({ enabled: true }))
      }
    })
    .catch((_err) => {
      defaultLogger.info('Warning: cannot get preview scene id')
    })

  function handleServerMessage(message: sdk.Messages) {
    if (DEBUG_WS_MESSAGES) {
      defaultLogger.info('Message received: ', message)
    }
    if (message.type === sdk.UPDATE || message.type === sdk.SCENE_UPDATE) {
      void loadPreviewScene(message)
    }
  }

  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${document.location.host}`)

  ws.addEventListener('message', (msg) => {
    if (msg.data.startsWith('{')) {
      // tslint:disable-next-line: no-console
      defaultLogger.log('Update message from CLI', msg.data)
      const message: sdk.Messages = JSON.parse(msg.data)
      handleServerMessage(message)
    }
  })
}
