import { redirect } from 'next/navigation'

// The page is called VPN now; old links keep working.
export default function RemoteAccessRedirect() {
  redirect('/vpn')
}
