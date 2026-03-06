async function login(event){

event.preventDefault()

const email = document.querySelector("input[type=email]").value
const password = document.querySelector("input[type=password]").value

const { data, error } = await supabaseClient.auth.signInWithPassword({
email: email,
password: password
})

if(error){

alert(error.message)

}else{

window.location.href = "home.html"

}

}