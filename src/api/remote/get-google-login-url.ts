import fetchClient from "../util/fetch";
import {SvrUri} from "../model/Consts";

const GetGoogleLoginUrl = async (loginCode:string) => {
	return await fetchClient({
		url: SvrUri + "/api/v1/obsidian/get_auth_url?code=" + loginCode,
		method: "GET",
	});
}

export default GetGoogleLoginUrl
