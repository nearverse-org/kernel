// tslint:disable:no-console
declare let globalThis: any & { isEditor: boolean; editor: any }
declare let window: Window & { isEditor: boolean }

globalThis.isEditor = window.isEditor = true

import { EventEmitter } from 'events'
import future, { IFuture } from 'fp-future'
import { Vector3 } from '@dcl/ecs-math'

import { loadedSceneWorkers } from '../shared/world/parcelSceneManager'
import { SceneJsonData, ILand, HUDElementID, BuilderConfiguration, WearableV2 } from '../shared/types'
import { normalizeContentMappings } from '../shared/selectors'
import { SceneWorker } from '../shared/world/SceneWorker'
import { initializeUnity } from '../unity-interface/initializer'
import { loadBuilderScene, updateBuilderScene, unloadCurrentBuilderScene } from '../unity-interface/dcl'
import defaultLogger from '../shared/logger'
import { uuid } from 'atomicHelpers/math'
import { sceneLifeCycleObservable } from '../decentraland-loader/lifecycle/controllers/scene'
import { UnityParcelScene } from 'unity-interface/UnityParcelScene'
import { getUnityInstance } from 'unity-interface/IUnityInterface'
import { futures } from 'unity-interface/BrowserInterface'

const evtEmitter = new EventEmitter()
const initializedEngine = future<void>()

let unityScene: UnityParcelScene | undefined
let loadingEntities: string[] = []
const builderSceneLoaded: IFuture<boolean> = future()

/**
 * Function executed by builder
 * It creates the builder scene, binds the scene events and stubs the content mappings
 */
async function createBuilderScene(scene: SceneJsonData, baseUrl: string, mappings: any) {
  const isFirstRun = unityScene === undefined
  const sceneData = await getSceneData(scene, baseUrl, mappings)
  unityScene = loadBuilderScene(sceneData)
  bindSceneEvents()

  const engineReady = future()
  sceneLifeCycleObservable.addOnce((obj) => {
    if (sceneData.sceneId === obj.sceneId && obj.status === 'ready') {
      engineReady.resolve(true)
    }
  })
  await engineReady

  if (isFirstRun) {
    getUnityInstance().SetBuilderReady()
  } else {
    getUnityInstance().ResetBuilderScene()
  }
  await builderSceneLoaded

  getUnityInstance().ActivateRendering()
  evtEmitter.emit('ready', {})
}

async function renewBuilderScene(scene: SceneJsonData, mappings: any) {
  if (unityScene) {
    const sceneData = await getSceneData(scene, unityScene.data.baseUrl, mappings)
    updateBuilderScene(sceneData)
  }
}

/**
 * It fakes the content mappings for being used at the Builder without
 * content server plus loads and creates the scene worker
 */
async function getSceneData(scene: SceneJsonData, baseUrl: string, mappings: any): Promise<ILand> {
  const id = getBaseCoords(scene)
  const contents = normalizeContentMappings(mappings || [])

  if (!baseUrl) {
    throw new Error('baseUrl missing in scene')
  }

  return {
    baseUrl: baseUrl,
    baseUrlBundles: '',
    sceneId: '0, 0',
    sceneJsonData: scene,
    mappingsResponse: {
      contents,
      parcel_id: id,
      root_cid: 'Qmtest'
    }
  }
}

/**
 * It returns base parcel if exists on `scene.json` or "0,0" if `baseParcel` missing
 */
function getBaseCoords(scene: SceneJsonData): string {
  if (scene && scene.scene && scene.scene.base) {
    const [x, y] = scene.scene.base.split(',').map(($) => parseInt($, 10))
    return `${x},${y}`
  }

  return '0,0'
}

function bindSceneEvents() {
  if (!unityScene) return

  unityScene.on('uuidEvent' as any, (event) => {
    const { type } = event.payload

    if (type === 'onEntityLoading') {
      loadingEntities.push(event.payload.entityId)
    } else if (type === 'onEntityFinishLoading') {
      const index = loadingEntities.indexOf(event.payload.entityId)
      if (index >= 0) {
        loadingEntities.splice(index, 1)
      }
    }
  })

  unityScene.on('metricsUpdate', (e) => {
    evtEmitter.emit('metrics', {
      metrics: e.given,
      limits: e.limit
    })
  })

  unityScene.on('entitiesOutOfBoundaries', (e) => {
    evtEmitter.emit('entitiesOutOfBoundaries', e)
  })

  unityScene.on('entityOutOfScene', (e) => {
    evtEmitter.emit('entityOutOfScene', e)
  })

  unityScene.on('entityBackInScene', (e) => {
    evtEmitter.emit('entityBackInScene', e)
  })

  unityScene.on('builderSceneStart', (_e) => {
    builderSceneLoaded.resolve(true)
  })

  unityScene.on('builderSceneUnloaded', (_e) => {
    loadingEntities = []
  })
  unityScene.on('gizmoEvent', (e) => {
    if (e.type === 'gizmoSelected') {
      evtEmitter.emit('gizmoSelected', {
        gizmoType: e.gizmoType,
        entities: e.entities
      })
    } else if (e.type === 'gizmoDragEnded') {
      evtEmitter.emit('transform', {
        transforms: e.transforms
      })
    }
  })
}

namespace editor {
  /**
   * Function executed by builder which is the first function of the entry point
   */
  export async function initEngine(container: HTMLElement) {
    try {
      await initializeUnity({ container })
      defaultLogger.log('Engine initialized.')
      getUnityInstance().ConfigureHUDElement(HUDElementID.NFT_INFO_DIALOG, { active: true, visible: false })
      getUnityInstance().ConfigureHUDElement(HUDElementID.OPEN_EXTERNAL_URL_PROMPT, { active: true, visible: false })
      getUnityInstance().ConfigureHUDElement(HUDElementID.TELEPORT_DIALOG, { active: true, visible: false })

      initializedEngine.resolve()
    } catch (err) {
      defaultLogger.error('Error loading Unity', err)
      initializedEngine.reject(err)
      throw err
    }
  }

  export async function handleMessage(message: any) {
    if (message.type === 'update') {
      await initializedEngine
      await createBuilderScene(message.payload.scene, message.payload.scene.baseUrl, message.payload.scene._mappings)
    }
  }

  export function setGridResolution(position: number, rotation: number, scale: number) {
    getUnityInstance().SetBuilderGridResolution(position, rotation, scale)
  }

  export function setSelectedEntities(entities: string[]) {
    getUnityInstance().SetBuilderSelectedEntities(entities)
  }

  export function getDCLCanvas() {
    return document.getElementById('#canvas')
  }

  export function getScenes(): Set<SceneWorker> {
    return new Set(loadedSceneWorkers.values())
  }

  export async function sendExternalAction(action: { type: string; payload: { [key: string]: any } }) {
    if (action.type === 'Close editor') {
      unloadCurrentBuilderScene()
      getUnityInstance().DeactivateRendering()
    } else if (unityScene) {
      const { worker } = unityScene
      if (action.payload.mappings) {
        const scene = { ...action.payload.scene }
        await renewBuilderScene(scene, action.payload.mappings)
      }
      worker.sendSubscriptionEvent('externalAction' as any, action)
    }
  }

  export function selectGizmo(type: string) {
    getUnityInstance().SelectGizmoBuilder(type)
  }

  export async function setPlayMode(on: boolean) {
    const onString: string = on ? 'true' : 'false'
    getUnityInstance().SetPlayModeBuilder(onString)
  }

  export function on(evt: string, listener: (...args: any[]) => void) {
    evtEmitter.addListener(evt, listener)
  }

  export function off(evt: string, listener: (...args: any[]) => void) {
    evtEmitter.removeListener(evt, listener)
  }

  export function setCameraZoomDelta(delta: number) {
    getUnityInstance().SetCameraZoomDeltaBuilder(delta)
  }

  export function getCameraTarget() {
    const id = uuid()
    futures[id] = future()
    getUnityInstance().GetCameraTargetBuilder(id)
    return futures[id]
  }

  export function resetCameraZoom() {
    getUnityInstance().ResetCameraZoomBuilder()
  }

  export function getMouseWorldPosition(x: number, y: number): IFuture<Vector3> {
    const id = uuid()
    futures[id] = future()
    getUnityInstance().GetMousePositionBuilder(x.toString(), y.toString(), id)
    return futures[id]
  }

  export function handleUnitySomeVale(id: string, value: Vector3) {
    futures[id].resolve(value)
  }

  export function preloadFile(url: string) {
    getUnityInstance().PreloadFileBuilder(url)
  }

  export function setCameraRotation(alpha: number, beta: number) {
    getUnityInstance().SetCameraRotationBuilder(alpha, beta)
  }

  export function getLoadingEntities() {
    if (loadingEntities.length === 0) {
      return null
    } else {
      return loadingEntities
    }
  }

  export function addWearablesToCatalog(wearables: WearableV2[]) {
    getUnityInstance().AddWearablesToCatalog(wearables)
  }

  export function removeWearablesFromCatalog(wearableIds: string[]) {
    getUnityInstance().RemoveWearablesFromCatalog(wearableIds)
  }

  export function takeScreenshot(_mime?: string): IFuture<string> {
    const id = uuid()
    futures[id] = future()
    getUnityInstance().TakeScreenshotBuilder(id)
    return futures[id]
  }

  export function setCameraPosition(position: Vector3) {
    getUnityInstance().SetCameraPositionBuilder(position)
  }

  export function onKeyDown(key: string) {
    getUnityInstance().OnBuilderKeyDown(key)
  }

  export function setBuilderConfiguration(config: BuilderConfiguration) {
    getUnityInstance().SetBuilderConfiguration(config)
  }
}

globalThis.editor = editor
