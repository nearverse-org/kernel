import { AnyAction, applyMiddleware, compose, createStore, Middleware, StoreEnhancer } from 'redux'
import createSagaMiddleware from 'redux-saga'
import { createLogger } from 'redux-logger'
import { reducers } from './rootReducer'
import { createRootSaga } from './rootSaga'
import { DEBUG_REDUX } from '../../config'
import { BringDownClientAndShowError, ErrorContext, ReportFatalError } from '../loading/ReportFatalError'
import defaultLogger from '../logger'
import { setStore } from './isolatedStore'
import { composeWithDevTools } from 'redux-devtools-extension'
import { logTrace } from 'unity-interface/trace'

export const buildStore = () => {
  const sagaMiddleware = createSagaMiddleware({
    onError: (error: Error, { sagaStack }: { sagaStack: string }) => {
      defaultLogger.log('SAGA-ERROR: ', error)
      ReportFatalError(error, ErrorContext.KERNEL_SAGA, { sagaStack })
      BringDownClientAndShowError(error.message as any)
    }
  })

  const middlewares: Middleware[] = [sagaMiddleware]

  middlewares.push((_store) => (next) => (action: AnyAction) => {
    logTrace(action.type, action.payload, 'KK')
    return next(action)
  })

  const composeEnhancers =
    (DEBUG_REDUX &&
      ((window as any).__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ || composeWithDevTools({ trace: true, traceLimit: 25 }))) ||
    compose

  const enhancers: StoreEnhancer<any>[] = [applyMiddleware(...middlewares)]

  if (DEBUG_REDUX) {
    enhancers.unshift(
      applyMiddleware(
        createLogger({
          collapsed: true,
          stateTransformer: () => null
        })
      )
    )
  }

  const store = createStore(reducers, composeEnhancers(...enhancers))
  const startSagas = () => sagaMiddleware.run(createRootSaga())
  setStore(store)
  return { store, startSagas }
}
