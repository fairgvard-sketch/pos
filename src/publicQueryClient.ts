import { QueryClient } from '@tanstack/react-query'

export function createPublicQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
        // iOS Safari can briefly report the page as offline after returning
        // from the camera/photo picker. Public fetches already have their own
        // timeout and error UI, so start them instead of leaving isPending
        // paused forever on "Loading restaurant…".
        networkMode: 'always',
      },
    },
  })
}
