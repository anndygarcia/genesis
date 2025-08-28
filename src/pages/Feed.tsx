import { useEffect, useState } from 'react'
import { Heart, MessageCircle, Share2 } from 'lucide-react'

// TODO: Replace mock with Supabase query joining projects + users
// type Post = { id: string; user: { id: string; name: string; avatarUrl?: string }; image: string; title: string; location?: string; likes: number; comments: number; createdAt: string }

export default function Feed() {
  const [loading, setLoading] = useState(true)
  const [posts, setPosts] = useState<any[]>([])

  useEffect(() => {
    let mounted = true
    // Mock data – swap for Supabase fetch
    const mock = [
      {
        id: 'p1',
        user: { id: 'u1', name: 'Ava Chen', avatarUrl: undefined },
        image: 'https://images.unsplash.com/photo-1501183638710-841dd1904471?q=80&w=1600&auto=format&fit=crop',
        title: 'Modern hillside retreat',
        location: 'Montecito, CA',
        likes: 128,
        comments: 12,
        createdAt: '2025-08-20T12:00:00Z',
      },
      {
        id: 'p2',
        user: { id: 'u2', name: 'Liam Patel', avatarUrl: undefined },
        image: 'https://images.unsplash.com/photo-1505691723518-36a5ac3b2a59?q=80&w=1600&auto=format&fit=crop',
        title: 'Lakefront glass pavilion',
        location: 'Lake Tahoe, NV',
        likes: 214,
        comments: 33,
        createdAt: '2025-08-21T16:30:00Z',
      },
      {
        id: 'p3',
        user: { id: 'u3', name: 'You', avatarUrl: undefined },
        image: 'https://images.unsplash.com/photo-1494526585095-c41746248156?q=80&w=1600&auto=format&fit=crop',
        title: 'Your latest concept',
        location: 'Austin, TX',
        likes: 42,
        comments: 5,
        createdAt: '2025-08-22T09:10:00Z',
      },
    ]
    setTimeout(() => { if (mounted) { setPosts(mock); setLoading(false) } }, 400)
    return () => { mounted = false }
  }, [])

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
      <h1 className="sr-only">Feed</h1>
      {loading ? (
        <div className="text-neutral-400">Loading feed…</div>
      ) : posts.length === 0 ? (
        <div className="text-neutral-400">No posts yet. Follow creators or upload your first project.</div>
      ) : (
        <ul className="space-y-6">
          {posts.map((post) => (
            <li key={post.id} className="rounded-xl border border-white/10 bg-neutral-900/60 overflow-hidden">
              <header className="flex items-center gap-3 p-3">
                <div className="h-10 w-10 rounded-full bg-neutral-800 border border-white/10 grid place-items-center text-neutral-300">
                  {(post.user.name?.[0] || 'U').toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="text-white font-medium truncate">{post.user.name}</div>
                  <div className="text-xs text-neutral-400 truncate">{post.location || '—'}</div>
                </div>
              </header>
              <figure className="aspect-[4/3] bg-neutral-800">
                <img src={post.image} alt={post.title} className="h-full w-full object-cover" />
              </figure>
              <div className="p-3">
                <div className="text-white font-medium">{post.title}</div>
                <div className="mt-3 flex items-center gap-4 text-neutral-300">
                  <button className="inline-flex items-center gap-1 hover:text-white">
                    <Heart className="size-4" />
                    <span className="text-sm">{post.likes}</span>
                  </button>
                  <button className="inline-flex items-center gap-1 hover:text-white">
                    <MessageCircle className="size-4" />
                    <span className="text-sm">{post.comments}</span>
                  </button>
                  <button className="inline-flex items-center gap-1 hover:text-white ml-auto">
                    <Share2 className="size-4" />
                    <span className="text-sm">Share</span>
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
