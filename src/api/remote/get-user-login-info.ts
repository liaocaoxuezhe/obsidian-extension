import fetchClient from "../util/fetch";
import {SvrUri} from "../model/Consts";

const GetUserLoginInfo = async (loginCode:string) => {
	return await fetchClient({
		url: SvrUri + "/api/v1/obsidian/get_user_login_info?code=" + loginCode,
		method: "GET",
	});
}

export default GetUserLoginInfo
