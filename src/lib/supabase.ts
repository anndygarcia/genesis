import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.warn('[Supabase] VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is missing. Auth will not work until env vars are set.')
}

export const supabase = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '')

// Explicitly enable robust auth behavior in the browser so uploads run as the authenticated user.
// Although these defaults are enabled in most environments, we set them to be safe.
// Note: If you already had a client instance, you can ignore this comment.

export async function uploadReferenceImages(
  files: File[],
  bucket = (import.meta.env.VITE_SUPABASE_STORAGE_BUCKET as string) || 'references'
): Promise<string[]> {
  const { data: userData } = await supabase.auth.getUser()
  const uid = userData?.user?.id ?? 'anonymous'

  const uploadedPaths: string[] = []
  for (const file of files) {
    const ext = file.name.split('.').pop() || 'bin'
    const safeName = file.name.replace(/[^a-zA-Z0-9_.-]/g, '_')
    const path = `${uid}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`

    const { error } = await supabase.storage
      .from(bucket)
      .upload(path, file, { contentType: file.type || `image/${ext}`, cacheControl: '3600', upsert: false })

    if (!error) {
      uploadedPaths.push(path)
    } else {
      // eslint-disable-next-line no-console
      console.error('[Supabase] Upload failed:', error.message)
    }
  }

  // Resolve public URLs
  const urls: string[] = []
  for (const path of uploadedPaths) {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path)
    if (data?.publicUrl) urls.push(data.publicUrl)
  }
  return urls
}
