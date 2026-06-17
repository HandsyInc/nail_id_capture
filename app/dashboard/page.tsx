import { auth } from '@clerk/nextjs/server'

export default async function DashboardPage() {
  const { userId } = await auth()

  return (
    <main style={{ padding: '2rem' }}>
      <h1>Handsy FIT Dashboard</h1>
      <p>Clerk User ID: {userId}</p>
    </main>
  )
}