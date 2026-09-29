import { Suspense, useEffect } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import RouteErrorBoundary from './components/RouteErrorBoundary'
import SuspenseFallback from './components/ui/SuspenseFallback'
import UpdateToast from './components/UpdateToast'
import { lazyWithRetry } from './lib/lazyWithRetry'
import { createPublicQueryClient } from './publicQueryClient'

const PublicOrderPage = lazyWithRetry(
  () => import('./features/online/PublicOrderPage'),
  'PublicOrderPage',
)
const PublicReservePage = lazyWithRetry(
  () => import('./features/reservations/PublicReservePage'),
  'PublicReservePage',
)
const RestaurantDirectoryHome = lazyWithRetry(
  () => import('./features/discovery/RestaurantDirectoryPage')
    .then((module) => ({ default: module.RestaurantDirectoryHome })),
  'RestaurantDirectoryHome',
)
const RestaurantDetailPage = lazyWithRetry(
  () => import('./features/discovery/RestaurantDirectoryPage')
    .then((module) => ({ default: module.RestaurantDetailPage })),
  'RestaurantDetailPage',
)

const queryClient = createPublicQueryClient()

/**
 * Сигнал «страница поднялась» родительскому окну.
 *
 * Встраивание — заявленный сценарий (сайт ресторана, превью в кабинете),
 * а у кросс-доменного iframe нет ни одного способа отличить отрисованную
 * страницу от заблокированного кадра: браузер показывает свою ошибку, и
 * снаружи она неотличима от пустой страницы. Одно сообщение без данных
 * закрывает этот вопрос — родитель показывает честное состояние вместо
 * молчаливого белого прямоугольника.
 */
function useEmbedReadySignal() {
  useEffect(() => {
    if (window.parent === window) return
    try {
      window.parent.postMessage(
        { source: 'angle-public', type: 'ready', path: window.location.pathname },
        '*'
      )
    } catch {
      // Родитель недоступен — молча живём дальше, гостю это не мешает
    }
  }, [])
}

export default function PublicApp() {
  useEmbedReadySignal()
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <RouteErrorBoundary>
          <Suspense fallback={<SuspenseFallback />}>
            <Routes>
              <Route path="/" element={<RestaurantDirectoryHome />} />
              <Route path="/restaurants/:slug" element={<RestaurantDetailPage />} />
              <Route path="/order/:locId" element={<PublicOrderPage />} />
              <Route path="/reserve/:locId" element={<PublicReservePage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
        {/* Гость с иконки на домашнем экране почти не перезагружает
            страницу — без этого он месяцами видел бы старое меню */}
        <UpdateToast />
      </BrowserRouter>
    </QueryClientProvider>
  )
}
