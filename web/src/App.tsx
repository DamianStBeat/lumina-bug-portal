import { lazy, Suspense } from 'react'
import { matchStatus, useRoute } from './router'
import Report from './pages/Report'
import AddVideo from './pages/AddVideo'
import Status from './pages/Status'

// The desk is for the team only: loaded on demand so players never download its code.
const Desk = lazy(() => import('./pages/desk/Desk'))

export default function App() {
  const { path } = useRoute()
  if (path === '/desk' || path.startsWith('/desk/')) {
    return (
      <Suspense fallback={null}>
        <Desk />
      </Suspense>
    )
  }
  if (path === '/add') return <AddVideo />
  if (matchStatus(path)) return <Status />
  // Unknown paths show the report form: a player who mistyped a link still lands somewhere useful.
  return <Report />
}
