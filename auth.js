async function checkAuth() {

const { data: { session } } = await supabaseClient.auth.getSession()

if (!session) {

window.location.href = "index.html"

}

}

checkAuth()

async function logout(){

await supabaseClient.auth.signOut()

window.location.href = "index.html"

}