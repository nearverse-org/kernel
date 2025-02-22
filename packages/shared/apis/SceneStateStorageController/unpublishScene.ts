import { Authenticator } from 'dcl-crypto'
import { ContentClient } from 'dcl-catalyst-client'
import { EntityType } from 'dcl-catalyst-commons'
import { getFetchContentServer } from 'shared/dao/selectors'
import { getCurrentIdentity } from 'shared/session/selectors'
import { EMPTY_PARCEL_NAME } from 'shared/atlas/selectors'
import { reloadScene } from 'decentraland-loader/lifecycle/utils/reloadScene'
import { fetchSceneIds } from 'decentraland-loader/lifecycle/utils/fetchSceneIds'
import { invalidateScene } from 'decentraland-loader/lifecycle/utils/invalidateScene'
import { DeploymentResult, CONTENT_PATH, SceneDeploymentSourceMetadata } from './types'
import { defaultLogger } from '../../logger'
import { ContentMapping, SceneJsonData } from '../../types'
import { jsonFetch } from '../../../atomicHelpers/jsonFetch'
import { blobToBuffer } from './SceneStateStorageController'
import { getResourcesURL } from 'shared/location'
import { getSceneWorkerBySceneID } from 'shared/world/parcelSceneManager'
import { getUnityInstance } from 'unity-interface/IUnityInterface'
import { store } from 'shared/store/isolatedStore'

declare type SceneDeployment = {
  sceneJson: SceneJsonData
  sceneFiles: Map<string, Buffer>
}

export async function unpublishSceneByCoords(coordinates: string): Promise<DeploymentResult> {
  let result

  try {
    // Get random empty scene files
    const { sceneJson, sceneFiles } = await getEmptySceneFiles(coordinates)

    const contentClient = getContentClient()

    const { files, entityId } = await contentClient.buildEntity({
      type: EntityType.SCENE,
      pointers: [coordinates],
      files: sceneFiles,
      metadata: {
        ...sceneJson,
        source: {
          origin: 'builder-in-world',
          version: 1,
          isEmpty: true
        } as SceneDeploymentSourceMetadata
      }
    })

    // Sign entity id and depploy
    const identity = getCurrentIdentity(store.getState())
    if (!identity) {
      throw new Error('Identity not found when trying to deploy an entity')
    }
    const authChain = Authenticator.signPayload(identity, entityId)

    const sceneIds = await fetchSceneIds([coordinates])
    await contentClient.deployEntity({ files, entityId, authChain })

    const sceneId = sceneIds && sceneIds[0]

    // Reload scene if running. Invalidate it if not
    if (sceneId) {
      if (getSceneWorkerBySceneID(sceneId)) {
        reloadScene(sceneId).catch((error) =>
          defaultLogger.error(`Failed reloading scene at coordinates ${coordinates}`, error)
        )
      } else {
        invalidateScene(sceneId).catch((error) =>
          defaultLogger.error(`Failed invalidating scene at coordinates ${coordinates}`, error)
        )
      }
    }

    result = { ok: true, error: '' }
  } catch (error) {
    result = { ok: false, error: `Unpublish failed ${error}` }
    defaultLogger.error('Unpublish failed', error)
  }

  getUnityInstance().SendUnpublishSceneResult(result)

  return result
}

async function getEmptySceneFiles(coordinates: string): Promise<SceneDeployment> {
  const fullRootUrl = getResourcesURL('loader/empty-scenes/')

  const scenes = await jsonFetch(fullRootUrl + 'mappings.json')
  const scenesContents: ContentMapping[][] = Object.values(scenes)
  const scenesNames: string[] = Object.keys(scenes)
  const randomSceneIndex: number = Math.floor(Math.random() * scenesContents.length)

  const emptySceneName: string = scenesNames[randomSceneIndex]
  const emptySceneBaseUrl: string = fullRootUrl + emptySceneName
  const emptySceneContentUrl: string = fullRootUrl + 'contents'
  const emptySceneMappings: ContentMapping[] = scenesContents[randomSceneIndex]
  const emptySceneJsonFile: string | undefined = emptySceneMappings.find(
    (content) => content.file === CONTENT_PATH.SCENE_FILE
  )?.hash
  const emptySceneGameFile: string | undefined = emptySceneMappings.find(
    (content) => content.file === CONTENT_PATH.BUNDLED_GAME_FILE
  )?.hash

  if (!emptySceneJsonFile) {
    throw Error(`empty-scene ${CONTENT_PATH.SCENE_FILE} file not found`)
  }

  if (!emptySceneGameFile) {
    throw Error(`empty-scene ${CONTENT_PATH.BUNDLED_GAME_FILE} file not found`)
  }

  const newSceneJson: SceneJsonData = await (await fetch(`${emptySceneBaseUrl}/${emptySceneJsonFile}`)).json()
  newSceneJson.scene.parcels = [coordinates]
  newSceneJson.scene.base = coordinates
  newSceneJson.display!.title = EMPTY_PARCEL_NAME

  const newSceneGameJS = await (await fetch(`${emptySceneContentUrl}/${emptySceneGameFile}`)).text()
  const newSceneModels = await getModelsFiles(emptySceneContentUrl, emptySceneMappings)

  const entityFiles: Map<string, Buffer> = new Map([
    [CONTENT_PATH.BUNDLED_GAME_FILE, Buffer.from(newSceneGameJS)],
    [CONTENT_PATH.SCENE_FILE, Buffer.from(JSON.stringify(newSceneJson))],
    ...newSceneModels
  ])

  return { sceneJson: newSceneJson, sceneFiles: entityFiles }
}

async function getModelsFiles(baseUrl: string, mappings: ContentMapping[]) {
  const assets = mappings.filter(
    (mapping) => mapping.file !== CONTENT_PATH.SCENE_FILE && mapping.file !== CONTENT_PATH.BUNDLED_GAME_FILE
  )

  const promises: Promise<[string, Buffer]>[] = assets.map<Promise<[string, Buffer]>>(async (asset) => {
    const response = await fetch(`${baseUrl}/${asset.hash}`)
    const blob = await response.blob()
    const buffer = await blobToBuffer(blob)
    return [asset.file, buffer]
  })

  const result = await Promise.all(promises)
  return new Map(result)
}

function getContentClient(): ContentClient {
  const contentUrl = getFetchContentServer(store.getState())
  return new ContentClient(contentUrl, 'builder in-world')
}
