import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

function ProfileSettings() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>('')
  const [notice, setNotice] = useState<string>('')
  const [showToast, setShowToast] = useState(false)

  const [userId, setUserId] = useState<string>('')
  const [email, setEmail] = useState<string>('')

  const [avatarUrl, setAvatarUrl] = useState<string>('')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [bio, setBio] = useState('')
  const [category, setCategory] = useState('')
  const [specialization, setSpecialization] = useState('')
  const [location, setLocation] = useState('')
  // Socials
  const [instagramUrl, setInstagramUrl] = useState('')
  const [facebookUrl, setFacebookUrl] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [linkedinUrl, setLinkedinUrl] = useState('')
  const [tiktokUrl, setTiktokUrl] = useState('')

  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const avatarPreview = useMemo(() => {
    if (avatarFile) return URL.createObjectURL(avatarFile)
    return avatarUrl || ''
  }, [avatarFile, avatarUrl])

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
        setCategory(meta.category || '')
        setSpecialization(meta.specialization || '')
        setLocation(meta.location || '')
        // Socials (support *_url fallbacks)
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

  useEffect(() => {
    if (!notice) return
    setShowToast(true)
    const t = setTimeout(() => setShowToast(false), 3000)
    return () => clearTimeout(t)
  }, [notice])

  async function refreshFromServer() {
    setError('')
    try {
      const { data, error } = await supabase.auth.getUser()
      if (error) throw error
      const u = data.user
      if (!u) return
      const meta = (u.user_metadata || {}) as any
      setAvatarUrl(meta.avatar_url || '')
      setFirstName(meta.first_name || '')
      setLastName(meta.last_name || '')
      setBio(meta.bio || '')
      setCategory(meta.category || '')
      setSpecialization(meta.specialization || '')
      setLocation(meta.location || '')
      setInstagramUrl(meta.instagram || meta.instagram_url || '')
      setFacebookUrl(meta.facebook || meta.facebook_url || '')
      setYoutubeUrl(meta.youtube || meta.youtube_url || '')
      setLinkedinUrl(meta.linkedin || meta.linkedin_url || '')
      setTiktokUrl(meta.tiktok || meta.tiktok_url || '')
      setNotice('Loaded latest profile from server')
    } catch (e: any) {
      setError(e?.message || 'Failed to refresh profile')
    }
  }

  async function uploadAvatarIfNeeded(): Promise<string | null> {
    if (!avatarFile || !userId) return null
    const ext = avatarFile.name.split('.').pop()?.toLowerCase() || 'jpg'
    const path = `${userId}/avatar.${ext}`
    const bucket = supabase.storage.from('avatars')
    const { error: upErr } = await bucket.upload(path, avatarFile, { upsert: true, cacheControl: '3600', contentType: avatarFile.type })
    if (upErr) {
      throw upErr
    }
    const { data: pub } = bucket.getPublicUrl(path)
    return pub.publicUrl
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return
    setError('')
    setNotice('')
    setSaving(true)
    try {
      let newAvatarUrl = avatarUrl
      if (avatarFile) {
        try {
          newAvatarUrl = (await uploadAvatarIfNeeded()) || avatarUrl
        } catch (e: any) {
          const msg = e?.message || ''
          if (/bucket.*not.*found/i.test(msg)) {
            // Bucket missing: continue saving other fields and keep existing avatar
            setNotice('Avatar bucket not found. Saved profile without updating photo.')
          } else {
            throw e
          }
        }
      }

      const { error: updErr } = await supabase.auth.updateUser({
        data: {
          avatar_url: newAvatarUrl,
          first_name: firstName,
          last_name: lastName,
          bio,
          category,
          specialization,
          location,
          // Socials
          instagram: instagramUrl,
          facebook: facebookUrl,
          youtube: youtubeUrl,
          linkedin: linkedinUrl,
          tiktok: tiktokUrl,
        },
      })
      if (updErr) throw updErr

      setAvatarUrl(newAvatarUrl)
      setAvatarFile(null)
      setNotice((n) => n || 'Profile updated successfully')

      // Pull fresh data from auth to verify the persisted values
      try {
        const { data } = await supabase.auth.getUser()
        const u = data.user
        if (u) {
          const meta = (u.user_metadata || {}) as any
          setAvatarUrl(meta.avatar_url || newAvatarUrl)
          setFirstName(meta.first_name ?? firstName)
          setLastName(meta.last_name ?? lastName)
          setBio(meta.bio ?? bio)
          setCategory(meta.category ?? category)
          setSpecialization(meta.specialization ?? specialization)
          setLocation(meta.location ?? location)
          setInstagramUrl(meta.instagram ?? instagramUrl)
          setFacebookUrl(meta.facebook ?? facebookUrl)
          setYoutubeUrl(meta.youtube ?? youtubeUrl)
          setLinkedinUrl(meta.linkedin ?? linkedinUrl)
          setTiktokUrl(meta.tiktok ?? tiktokUrl)
        }
      } catch {}
    } catch (e: any) {
      const msg = e?.message || 'Failed to save profile'
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

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

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Success toast */}
      <div className={`fixed top-20 right-6 z-20 transition-all duration-300 ${showToast ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2 pointer-events-none'}`} role="status" aria-live="polite">
        {notice && (
          <div className="flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-600/15 text-emerald-300 px-4 py-2 shadow-lg">
            <span className="text-sm">{notice}</span>
            <button
              type="button"
              className="ml-2 text-emerald-200/80 hover:text-emerald-100"
              onClick={() => setShowToast(false)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
      </div>
      <h1 className="text-2xl font-semibold text-white">Profile Settings</h1>
      <p className="mt-1 text-sm text-neutral-400">Signed in as {email}</p>

      <form onSubmit={onSave} className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Avatar card */}
        <div className="md:col-span-1">
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4">
            <div className="flex flex-col items-center gap-3">
              <div className="h-28 w-28 rounded-full bg-neutral-800 border border-white/10 overflow-hidden grid place-items-center">
                {avatarPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarPreview} alt="Avatar" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-neutral-400">No photo</span>
                )}
              </div>
              <div className="flex gap-2">
                <label className="cursor-pointer rounded-md border border-white/10 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-white/5">
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => setAvatarFile(e.target.files?.[0] || null)}
                  />
                  Upload
                </label>
                {avatarPreview && (
                  <button
                    type="button"
                    className="rounded-md border border-white/10 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 hover:bg-white/5"
                    onClick={() => { setAvatarFile(null); setAvatarUrl('') }}
                  >
                    Remove
                  </button>
                )}
              </div>
              {/* Name fields */}
              <div className="w-full grid grid-cols-1 gap-3 mt-2">
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-neutral-300">First name</label>
                  <input
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Tony"
                    className="rounded-md bg-neutral-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm text-neutral-300">Last name</label>
                  <input
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Stark"
                    className="rounded-md bg-neutral-800 border border-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-[#a588ef] text-white placeholder:text-white/60"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Details form */}
        <div className="md:col-span-2">
          <div className="rounded-2xl border border-white/10 bg-neutral-900 p-4 space-y-4">
            <div>
              <label className="block text-sm text-neutral-300">Bio</label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={4}
                placeholder="Tell people about yourself…"
                className="mt-1 w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-[#a588ef]"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-neutral-300">Business category</label>
                <input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g., Real Estate, Construction, Interior Design"
                  className="mt-1 w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-[#a588ef]"
                />
              </div>
              <div>
                <label className="block text-sm text-neutral-300">Specialization</label>
                <input
                  value={specialization}
                  onChange={(e) => setSpecialization(e.target.value)}
                  placeholder="e.g., Luxury homes, Kitchen remodels, Staging"
                  className="mt-1 w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-[#a588ef]"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-neutral-300">Location</label>
              <input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City, State / Country"
                className="mt-1 w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-[#a588ef]"
              />
            </div>

            {/* Socials section */}
            <div className="pt-2">
              <h3 className="text-sm font-medium text-white">Socials</h3>
              <p className="text-xs text-neutral-400 mt-0.5">Add links to your profiles. These appear on your public profile.</p>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-neutral-300">Instagram URL</label>
                  <input
                    value={instagramUrl}
                    onChange={(e) => setInstagramUrl(e.target.value)}
                    placeholder="https://instagram.com/your-handle"
                    inputMode="url"
                    className="mt-1 w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-[#a588ef]"
                  />
                </div>
                <div>
                  <label className="block text-sm text-neutral-300">Facebook URL</label>
                  <input
                    value={facebookUrl}
                    onChange={(e) => setFacebookUrl(e.target.value)}
                    placeholder="https://facebook.com/your-page"
                    inputMode="url"
                    className="mt-1 w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-[#a588ef]"
                  />
                </div>
                <div>
                  <label className="block text-sm text-neutral-300">YouTube URL</label>
                  <input
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    placeholder="https://youtube.com/@your-channel"
                    inputMode="url"
                    className="mt-1 w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-[#a588ef]"
                  />
                </div>
                <div>
                  <label className="block text-sm text-neutral-300">LinkedIn URL</label>
                  <input
                    value={linkedinUrl}
                    onChange={(e) => setLinkedinUrl(e.target.value)}
                    placeholder="https://linkedin.com/in/your-profile"
                    inputMode="url"
                    className="mt-1 w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-[#a588ef]"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm text-neutral-300">TikTok URL</label>
                  <input
                    value={tiktokUrl}
                    onChange={(e) => setTiktokUrl(e.target.value)}
                    placeholder="https://www.tiktok.com/@your-handle"
                    inputMode="url"
                    className="mt-1 w-full rounded-md bg-neutral-800 border border-white/10 px-3 py-2 text-white placeholder:text-white/60 outline-none focus:ring-2 focus:ring-[#a588ef]"
                  />
                </div>
              </div>
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}
            {notice && <p className="text-sm text-emerald-300">{notice}</p>}

            <div className="flex items-center justify-between gap-3">
              <button type="button" onClick={refreshFromServer} className="text-sm text-neutral-400 hover:text-neutral-200">Refresh from server</button>
              <button
                type="submit"
                disabled={saving}
                className={`btn-accent rounded-md px-4 py-2 text-white ${saving ? 'opacity-70 cursor-not-allowed' : ''}`}
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}

export default ProfileSettings
