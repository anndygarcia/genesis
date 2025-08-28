import { useEffect, useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { Plus, Instagram, Facebook, Youtube, Linkedin, Music2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

function Profile() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>('')

  const [userId, setUserId] = useState<string>('')
  const [email, setEmail] = useState<string>('')

  const [avatarUrl, setAvatarUrl] = useState<string>('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [bio, setBio] = useState('')
  const [location, setLocation] = useState('')
  const [category, setCategory] = useState('')
  const [specialization, setSpecialization] = useState('')
  const [instagramUrl, setInstagramUrl] = useState('')
  const [facebookUrl, setFacebookUrl] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [tiktokUrl, setTiktokUrl] = useState('')

  const avatarPreview = useMemo(() => avatarUrl || '', [avatarUrl])

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const { data, error } = await supabase.auth.getUser()
        if (error) throw error
        const u = data.user
        if (!u) {
          setError('Please log in to edit your profile.')
          return
        }
        if (!mounted) return
        setUserId(u.id)
        setEmail(u.email || '')
        const meta = (u.user_metadata || {}) as any
        setAvatarUrl(meta.avatar_url || '')
        setFirstName(meta.first_name || '')
        setLastName(meta.last_name || '')
        setBio(meta.bio || '')
        setLocation(meta.location || '')
        setCategory(meta.category || '')
        setSpecialization(meta.specialization || '')
        setInstagramUrl(meta.instagram || meta.instagram_url || '')
        setFacebookUrl(meta.facebook || meta.facebook_url || '')
        setYoutubeUrl(meta.youtube || meta.youtube_url || '')
        setLinkedinUrl(meta.linkedin || meta.linkedin_url || '')
        setTiktokUrl(meta.tiktok || meta.tiktok_url || '')
      } catch (e: any) {
        setError(e?.message || 'Failed to load profile')
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => { mounted = false }
  }, [])

  // Read-only page: no mutation handlers

  if (loading) {
    return (
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="text-neutral-300">Loading profile…</div>
      </div>
    )
  }

  if (error && !userId) {
    return (
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <p className="text-red-400">{error}</p>
      </div>
    )
  }

  // Compute display name
  const displayName = (() => {
    const fn = (firstName || '').trim()
    const ln = (lastName || '').trim()
    if (fn || ln) return `${fn}${fn && ln ? ' ' : ''}${ln}`.trim()
    return email || 'Profile'
  })()

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-start gap-6">
        <div className="h-28 w-28 rounded-full bg-neutral-800 border border-white/10 overflow-hidden grid place-items-center">
          {avatarPreview ? (
            <img src={avatarPreview} alt={displayName} className="h-full w-full object-cover" />
          ) : (
            <span className="text-neutral-400 text-xl">{(email?.[0] || 'U').toUpperCase()}</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-semibold text-white truncate">{displayName}</h1>
            {userId && (
              <NavLink to="/profile/settings" className="btn-accent rounded-md px-3 py-1.5 text-white text-sm">
                Edit Profile
              </NavLink>
            )}
            {/* Social icons (always visible). If URL missing, link to settings */}
            <div className="ml-1 flex items-center gap-2">
              {instagramUrl ? (
                <a
                  href={instagramUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                  className="p-1 rounded-md text-neutral-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef] transform-gpu transition duration-200 ease-out hover:scale-110"
                  title="Instagram"
                >
                  <Instagram className="h-5 w-5" />
                </a>
              ) : (
                <NavLink
                  to="/profile/settings"
                  aria-label="Add Instagram"
                  className="p-1 rounded-md text-neutral-500 hover:text-neutral-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef]"
                  title="Add Instagram"
                >
                  <Instagram className="h-5 w-5" />
                </NavLink>
              )}

              {facebookUrl ? (
                <a
                  href={facebookUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Facebook"
                  className="p-1 rounded-md text-neutral-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef] transform-gpu transition duration-200 ease-out hover:scale-110"
                  title="Facebook"
                >
                  <Facebook className="h-5 w-5" />
                </a>
              ) : (
                <NavLink
                  to="/profile/settings"
                  aria-label="Add Facebook"
                  className="p-1 rounded-md text-neutral-500 hover:text-neutral-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef]"
                  title="Add Facebook"
                >
                  <Facebook className="h-5 w-5" />
                </NavLink>
              )}

              {youtubeUrl ? (
                <a
                  href={youtubeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="YouTube"
                  className="p-1 rounded-md text-neutral-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef] transform-gpu transition duration-200 ease-out hover:scale-110"
                  title="YouTube"
                >
                  <Youtube className="h-5 w-5" />
                </a>
              ) : (
                <NavLink
                  to="/profile/settings"
                  aria-label="Add YouTube"
                  className="p-1 rounded-md text-neutral-500 hover:text-neutral-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef]"
                  title="Add YouTube"
                >
                  <Youtube className="h-5 w-5" />
                </NavLink>
              )}

              {linkedinUrl ? (
                <a
                  href={linkedinUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="LinkedIn"
                  className="p-1 rounded-md text-neutral-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef] transform-gpu transition duration-200 ease-out hover:scale-110"
                  title="LinkedIn"
                >
                  <Linkedin className="h-5 w-5" />
                </a>
              ) : (
                <NavLink
                  to="/profile/settings"
                  aria-label="Add LinkedIn"
                  className="p-1 rounded-md text-neutral-500 hover:text-neutral-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef]"
                  title="Add LinkedIn"
                >
                  <Linkedin className="h-5 w-5" />
                </NavLink>
              )}

              {tiktokUrl ? (
                <a
                  href={tiktokUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="TikTok"
                  className="p-1 rounded-md text-neutral-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef] transform-gpu transition duration-200 ease-out hover:scale-110"
                  title="TikTok"
                >
                  <Music2 className="h-5 w-5" />
                </a>
              ) : (
                <NavLink
                  to="/profile/settings"
                  aria-label="Add TikTok"
                  className="p-1 rounded-md text-neutral-500 hover:text-neutral-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef]"
                  title="Add TikTok"
                >
                  <Music2 className="h-5 w-5" />
                </NavLink>
              )}
            </div>
          </div>
          {bio && (
            <p className="mt-2 text-sm text-neutral-300 max-w-2xl whitespace-pre-wrap text-left">{bio}</p>
          )}
          {location && (
            <div className="mt-4">
              <h3 className="text-xs uppercase tracking-wide text-left text-[#a588ef]">Location</h3>
              <p className="text-sm text-neutral-300 text-left">{location}</p>
            </div>
          )}
          {(category || specialization) && (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-6">
              {category && (
                <div>
                  <h3 className="text-xs uppercase tracking-wide text-left text-[#a588ef]">Category</h3>
                  <p className="text-sm text-neutral-300 text-left">{category}</p>
                </div>
              )}
              {specialization && (
                <div>
                  <h3 className="text-xs uppercase tracking-wide text-left text-[#a588ef]">Specialization</h3>
                  <p className="text-sm text-neutral-300 text-left">{specialization}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Projects grid */}
      <div className="mt-8">
        <h2 className="text-lg font-medium text-white mb-3">Projects</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <NavLink
              key={i}
              to="/projects/new"
              aria-label="Create new project"
              className="group relative aspect-square rounded-xl border border-white/10 bg-neutral-900/60 text-neutral-500 transform-gpu transition-transform duration-300 ease-out hover:scale-105 overflow-hidden cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#a588ef]"
            >
              <span className="absolute inset-0 grid place-items-center transition-opacity duration-300 ease-out group-hover:opacity-0">
                Coming soon
              </span>
              <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity duration-300 ease-out group-hover:opacity-100">
                <Plus className="h-10 w-10 text-neutral-300" />
              </span>
            </NavLink>
          ))}
        </div>
        {!userId && (
          <p className="mt-4 text-sm text-neutral-400">Sign in to see and manage your projects.</p>
        )}
      </div>
    </div>
  )
}

export default Profile
